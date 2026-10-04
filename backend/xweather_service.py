from datetime import datetime, timezone, timedelta

import requests
import pandas as pd
import pvlib

from config import (
    XWEATHER_CLIENT_ID, XWEATHER_CLIENT_SECRET,
    XWEATHER_API_HOST, XWEATHER_FORECAST_PATH,
)

IST = timezone(timedelta(hours=5, minutes=30))

FIELDS = ",".join([
    "periods.dateTimeISO",
    "periods.tempC",
    "periods.windSpeedMPS",
    "periods.humidity",
    "periods.solrad.ghiWM2",
    "periods.solrad.dniWM2",
    "periods.solrad.dhiWM2",
])


def _to_ist(iso_str):
    if not iso_str:
        return iso_str
    try:
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(IST).isoformat()
    except (ValueError, TypeError):
        return iso_str


def _compute_poa(ghi, dni, dhi, timestamp_ist, lat, lon, tilt, azimuth):
    if ghi is None or dni is None or dhi is None:
        return None, None, None

    if ghi <= 0 and dni <= 0 and dhi <= 0:
        return 0.0, 0.0, 0.0

    try:
        times = pd.DatetimeIndex([timestamp_ist])
        solpos = pvlib.solarposition.get_solarposition(times, lat, lon)
        dni_extra = pvlib.irradiance.get_extra_radiation(times)
        total = pvlib.irradiance.get_total_irradiance(
            surface_tilt=tilt,
            surface_azimuth=azimuth,
            solar_zenith=solpos["apparent_zenith"].iloc[0],
            solar_azimuth=solpos["azimuth"].iloc[0],
            dni=dni,
            ghi=ghi,
            dhi=dhi,
            dni_extra=dni_extra.iloc[0],
            model="perez",
        )
        return (
            round(float(total["poa_global"]), 2),
            round(float(total["poa_direct"]), 2),
            round(float(total["poa_diffuse"]), 2),
        )
    except Exception as e:
        print(f"[POA DEBUG] compute_poa failed: {type(e).__name__}: {e}")
        return None, None, None


def fetch_solar_forecast(lat, lon, tilt=None, azimuth=None, hours=24, interval=1):
    """
    Calls the real Xweather /forecasts endpoint (raw, hourly). Used by
    the 15-min continuous tick log.
    """
    # Fail fast and loudly if credentials are missing, instead of letting
    # the request go out with client_id=None / client_secret=None and
    # silently getting rejected by the API.
    if not XWEATHER_CLIENT_ID or not XWEATHER_CLIENT_SECRET:
        raise RuntimeError(
            "Xweather credentials missing — check XWEATHER_CLIENT_ID / "
            "XWEATHER_CLIENT_SECRET in .env"
        )

    path = XWEATHER_FORECAST_PATH.format(lat=lat, lon=lon)
    url = f"https://{XWEATHER_API_HOST}{path}"

    params = {
        "client_id": XWEATHER_CLIENT_ID,
        "client_secret": XWEATHER_CLIENT_SECRET,
        "filter": "1hr",
        "limit": hours,
        "fields": FIELDS,
    }

    resp = requests.get(url, params=params, timeout=15)

    # Surface HTTP-level failures (401/403/etc.) with the actual response
    # body, instead of raise_for_status() hiding it behind a generic
    # HTTPError before we ever see what Xweather said was wrong.
    if not resp.ok:
        raise RuntimeError(
            f"Xweather HTTP {resp.status_code} for {url}: {resp.text[:300]}"
        )

    payload = resp.json()
    print(f"[XWEATHER DEBUG] status={resp.status_code} success={payload.get('success')} "
          f"url={resp.url}")

    if not payload.get("success"):
        raise RuntimeError(payload.get("error") or "Xweather request failed")

    results = payload.get("response") or []
    periods = results[0].get("periods", []) if results else []

    if not periods:
        # A "success" response with zero periods is still a failure for our
        # purposes — raise instead of quietly returning [] so callers (and
        # the CSV log) don't mistake "no data" for "nothing went wrong".
        raise RuntimeError(
            f"Xweather returned success but no periods for lat={lat}, lon={lon} "
            f"(raw response: {str(payload)[:300]})"
        )

    cleaned = []
    for point in periods:
        time_ist = _to_ist(point.get("dateTimeISO"))
        solrad = point.get("solrad") or {}
        ghi = solrad.get("ghiWM2")
        dni = solrad.get("dniWM2")
        dhi = solrad.get("dhiWM2")

        poa_global = poa_direct = poa_diffuse = None
        if tilt is not None and azimuth is not None and time_ist:
            poa_global, poa_direct, poa_diffuse = _compute_poa(
                ghi, dni, dhi, time_ist, lat, lon, tilt, azimuth
            )

        cleaned.append({
            "time": time_ist,
            "ghi": ghi,
            "dni": dni,
            "dhi": dhi,
            "temperature": point.get("tempC"),
            "windSpeed": point.get("windSpeedMPS"),
            "humidity": point.get("humidity"),
            "poaGlobal": poa_global,
            "poaDirect": poa_direct,
            "poaDiffuse": poa_diffuse,
        })

    return cleaned


def _next_15min_boundary(dt):
    """The next 15-min-aligned timestamp strictly after dt.
    6:45 -> 7:00, 10:15 -> 10:30, 10:17 -> 10:30."""
    dt_floor = dt.replace(second=0, microsecond=0)
    dt_floor -= timedelta(minutes=dt_floor.minute % 15)
    return dt_floor + timedelta(minutes=15)


def fetch_solar_forecast_15min(lat, lon, tilt=None, azimuth=None):
    """
    Interpolates Xweather's raw hourly data to 96 rows at 15-minute
    resolution, covering a full 24h window starting at the next 15-min
    boundary strictly after the moment this is called. Used by BOTH the
    /api/weather endpoint (so the frontend's 15-min chart has a real
    value at every slot) and the fixed daily snapshot captures.

    POA is recomputed per 15-min timestamp for accuracy. Humidity rounds
    to the nearest whole number; everything else rounds to 2dp.
    """
    raw = fetch_solar_forecast(lat, lon, tilt=None, azimuth=None, hours=30)
    if not raw:
        # fetch_solar_forecast now raises instead of returning [] on empty
        # data, so this branch should be unreachable — kept only as a
        # last-resort guard.
        raise RuntimeError("Xweather raw forecast came back empty")

    now_ist = datetime.now(IST)
    start = _next_15min_boundary(now_ist)
    target_index = pd.date_range(start=start, periods=96, freq="15min")

    raw_times = pd.DatetimeIndex([pd.Timestamp(p["time"]) for p in raw])

    def _series(key):
        return pd.Series([p[key] for p in raw], index=raw_times).sort_index()

    def _interp(s):
        combined = s.reindex(s.index.union(target_index)).astype(float)
        combined = combined.interpolate(method="time")
        combined = combined.reindex(target_index)
        return combined.ffill().bfill()

    ghi_i = _interp(_series("ghi"))
    dni_i = _interp(_series("dni"))
    dhi_i = _interp(_series("dhi"))
    temp_i = _interp(_series("temperature"))
    wind_i = _interp(_series("windSpeed"))
    hum_i = _interp(_series("humidity"))

    cleaned = []
    for t in target_index:
        t_iso = t.isoformat()
        ghi, dni, dhi = ghi_i[t], dni_i[t], dhi_i[t]

        poa_global = poa_direct = poa_diffuse = None
        if tilt is not None and azimuth is not None:
            poa_global, poa_direct, poa_diffuse = _compute_poa(
                ghi, dni, dhi, t_iso, lat, lon, tilt, azimuth
            )

        cleaned.append({
            "time": t_iso,
            "ghi": round(float(ghi), 2),
            "dni": round(float(dni), 2),
            "dhi": round(float(dhi), 2),
            "temperature": round(float(temp_i[t]), 2),
            "windSpeed": round(float(wind_i[t]), 2),
            "humidity": int(round(float(hum_i[t]))),
            "poaGlobal": poa_global,
            "poaDirect": poa_direct,
            "poaDiffuse": poa_diffuse,
        })

    return cleaned