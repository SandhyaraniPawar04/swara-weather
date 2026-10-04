import os
import csv
from datetime import datetime, timezone, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from config import SITES, DATA_DIR, PILOT_SITES, PILOT_SITE_DISPLAY_NAMES, CAPTURE_TIMES, SNAPSHOT_DIR
from xweather_service import fetch_solar_forecast, fetch_solar_forecast_15min
from report_builder import build_reports_for_all_pilot_sites
from excel_report_builder import build_excel_report, build_excel_reports_for_all_pilot_sites

os.makedirs(DATA_DIR, exist_ok=True)

IST = timezone(timedelta(hours=5, minutes=30))

FIELDNAMES = [
    "time", "ghi", "dni", "dhi", "temperature", "windSpeed", "humidity",
    "poaGlobal", "poaDirect", "poaDiffuse",
    "call_at",
]

# Raw hourly (non-interpolated) Xweather points for the pilot sites only —
# each tick writes a brand-new snapshot file (no merging, no "completed
# only" filtering) so it never gets mixed with the interpolated 15-min
# rows that /api/weather logs into the daily file via log_forecast_to_csv.
HOURLY_FIELDNAMES = [
    "time", "ghi", "dni", "dhi", "temperature", "windSpeed", "humidity",
    "poaGlobal", "poaDirect", "poaDiffuse",
]


def _next_hour_boundary(dt):
    """The next top-of-the-hour timestamp strictly after dt.
    7:10 -> 8:00, 7:00 -> 8:00, 7:59 -> 8:00."""
    floored = dt.replace(minute=0, second=0, microsecond=0)
    return floored + timedelta(hours=1)


def log_hourly_forecast_to_csv(site_name, forecast_points):
    """
    Saves RAW hourly Xweather forecast points (no interpolation) for a
    pilot site as a brand-new snapshot file each time it's called:
        data/<SITE>/raw_hourly_<SITE>_<YYYY-MM-DD>_<HHMM>.csv
    where <HHMM> is the time this fetch/tick happened.

    The saved window always starts at the next full-hour boundary after
    the moment this runs (e.g. a 7:10 fetch saves data starting 8:00) and
    covers a complete 24 hours from there — regardless of what raw window
    Xweather happened to return. Points are matched to each target hour
    by exact timestamp; nothing is interpolated or invented — an hour is
    only written if Xweather actually returned a point for it.
    """
    site_dir = os.path.join(DATA_DIR, site_name)
    os.makedirs(site_dir, exist_ok=True)

    now = datetime.now(IST)
    date_str = now.strftime("%Y-%m-%d")
    time_tag = now.strftime("%H%M")
    file_path = os.path.join(site_dir, f"raw_hourly_{site_name}_{date_str}_{time_tag}.csv")

    # Index the raw points by their exact hour timestamp.
    points_by_hour = {}
    for point in forecast_points:
        try:
            point_dt = datetime.fromisoformat(point["time"].replace("Z", "+00:00"))
            if point_dt.tzinfo is None:
                point_dt = point_dt.replace(tzinfo=IST)
            point_dt_ist = point_dt.astimezone(IST)
        except (ValueError, TypeError, KeyError):
            continue
        points_by_hour[point_dt_ist.replace(minute=0, second=0, microsecond=0)] = point

    window_start = _next_hour_boundary(now)
    target_hours = [window_start + timedelta(hours=i) for i in range(24)]

    rows = []
    missing = []
    for hour in target_hours:
        point = points_by_hour.get(hour)
        if point is None:
            missing.append(hour.strftime("%Y-%m-%d %H:%M"))
            continue
        # Values (ghi/dni/temperature/etc) are exactly what Xweather
        # returned for this hour — untouched, no interpolation. Only the
        # displayed "time" is normalized to the clean :00 hour boundary
        # this point was matched against, instead of Xweather's raw
        # timestamp (which comes back at :30 because Xweather's periods
        # are hourly in UTC, and UTC -> IST is a +5:30 shift).
        row = dict(point)
        row["time"] = hour.isoformat()
        rows.append(row)

    with open(file_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HOURLY_FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        for point in rows:
            writer.writerow({k: point.get(k) for k in HOURLY_FIELDNAMES})

    print(
        f"[{now}] Saved {len(rows)}/24 raw hourly points for {site_name} "
        f"(window {window_start.strftime('%Y-%m-%d %H:%M')} -> "
        f"{target_hours[-1].strftime('%Y-%m-%d %H:%M')}) -> {file_path}"
    )
    if missing:
        print(f"[{now}] {site_name}: no Xweather data returned for hours: {missing}")


def log_forecast_to_csv(site_name, forecast_points):
    site_dir = os.path.join(DATA_DIR, site_name)
    os.makedirs(site_dir, exist_ok=True)

    now = datetime.now(IST)
    today_str = now.strftime("%d_%B_%Y")
    file_path = os.path.join(site_dir, f"{today_str}.csv")
    call_time_str = now.strftime("%Y-%m-%d %H:%M")

    existing_rows = {}
    if os.path.isfile(file_path):
        with open(file_path, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                filtered_row = {k: v for k, v in row.items() if k in FIELDNAMES}
                existing_rows[row["time"]] = filtered_row

    saved_count = 0
    for point in forecast_points:
        point_time = point["time"]
        try:
            point_dt = datetime.fromisoformat(point_time.replace("Z", "+00:00"))
            if point_dt.tzinfo is None:
                point_dt = point_dt.replace(tzinfo=IST)
            point_dt_ist = point_dt.astimezone(IST)
        except (ValueError, TypeError):
            continue

        if point_dt_ist > now:
            continue

        existing_rows[point_time] = {
            "time": point_time,
            "ghi": point["ghi"],
            "dni": point["dni"],
            "dhi": point["dhi"],
            "temperature": point["temperature"],
            "windSpeed": point["windSpeed"],
            "humidity": point["humidity"],
            "poaGlobal": point["poaGlobal"],
            "poaDirect": point["poaDirect"],
            "poaDiffuse": point["poaDiffuse"],
            "call_at": call_time_str,
        }
        saved_count += 1

    with open(file_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for row in sorted(existing_rows.values(), key=lambda r: r["time"]):
            writer.writerow(row)

    print(f"[{now}] Logged {saved_count} completed-time points for {site_name} -> {file_path}")


CANDIDATE_SNAPSHOT_FIELDS = [
    "ghi", "dni", "dhi", "temperature", "windSpeed", "humidity",
    "poaGlobal", "poaDirect", "poaDiffuse",
]


def build_dynamic_fieldnames(forecast_points):
    present = [
        field for field in CANDIDATE_SNAPSHOT_FIELDS
        if any(point.get(field) is not None for point in forecast_points)
    ]
    return ["time"] + present


def save_forecast_snapshot(site_key, forecast_points, capture_time_str):
    display_name = PILOT_SITE_DISPLAY_NAMES.get(site_key, site_key)
    site_dir = os.path.join(SNAPSHOT_DIR, display_name)
    os.makedirs(site_dir, exist_ok=True)

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_tag = capture_time_str.replace(":", "")
    file_name = f"{display_name}_{date_str}_{time_tag}.csv"
    file_path = os.path.join(site_dir, file_name)

    if os.path.isfile(file_path):
        print(f"[{now}] SKIP (already exists, not overwriting): {file_path}")
        return

    fieldnames = build_dynamic_fieldnames(forecast_points)

    with open(file_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for point in forecast_points:
            writer.writerow({k: point.get(k) for k in fieldnames})

    print(f"[{now}] Snapshot saved: {file_path} ({len(forecast_points)} points, columns: {fieldnames})")


def capture_snapshot_job(capture_time_str):
    print(f"\n===== SNAPSHOT CAPTURE ({capture_time_str}) at {datetime.now()} =====")
    for site_key in PILOT_SITES:
        site = SITES[site_key]

        # 15-min interpolated snapshot -> forecast/ folder (UNCHANGED).
        try:
            points_15min = fetch_solar_forecast_15min(
                site["lat"], site["lon"], tilt=site["tilt"], azimuth=site["azimuth"]
            )
            save_forecast_snapshot(site_key, points_15min, capture_time_str)
        except Exception as e:
            print(f"[{datetime.now()}] FAILED snapshot for {site_key} @ {capture_time_str}: {e}")
        else:
            # Rebuild this site's combined Excel report now that a new
            # real capture has landed, so it fills in progressively
            # through the day (one more real column each call) instead
            # of only once at the end of the day.
            try:
                build_excel_report(site_key)
            except Exception as e:
                print(f"[{datetime.now()}] FAILED excel rebuild for {site_key} @ {capture_time_str}: {e}")

        # Raw hourly (non-interpolated) snapshot -> data/ folder. Fires once
        # per capture time (same moments as the line above), NOT on every
        # 15-min continuous tick. hours=26 gives a small buffer past 24h so
        # the 24h hourly window (next hour boundary -> +24h) is always fully
        # covered even right at an hour edge.
        try:
            raw_points = fetch_solar_forecast(
                site["lat"], site["lon"], tilt=site["tilt"], azimuth=site["azimuth"],
                hours=26,
            )
            log_hourly_forecast_to_csv(site_key, raw_points)
        except Exception as e:
            print(f"[{datetime.now()}] FAILED hourly log for {site_key} @ {capture_time_str}: {e}")
    print(f"===== SNAPSHOT CAPTURE COMPLETE ({capture_time_str}) =====\n")

    # Rebuild the combined Excel report right away with whatever captures
    # exist so far today — so it updates progressively through the day
    # (1 real column after the first capture, 2 after the second, etc.)
    # instead of only once at the end of the day.
    try:
        build_excel_reports_for_all_pilot_sites()
    except Exception as e:
        print(f"[{datetime.now()}] FAILED excel rebuild after {capture_time_str}: {e}")


def scheduled_job():
    print(f"\n===== SCHEDULER TICK at {datetime.now()} =====")
    for site_name, site in SITES.items():
        try:
            points = fetch_solar_forecast(
                site["lat"], site["lon"], tilt=site["tilt"], azimuth=site["azimuth"],
                hours=26,
            )
            log_forecast_to_csv(site_name, points)
        except Exception as e:
            print(f"[{datetime.now()}] Failed to fetch/log {site_name}: {e}")
    print(f"===== TICK COMPLETE at {datetime.now()} =====\n")


def daily_report_job():
    print(f"\n===== DAILY REPORT BUILD at {datetime.now()} =====")
    build_reports_for_all_pilot_sites()
    print(f"===== DAILY REPORT BUILD COMPLETE =====\n")


def start_scheduler():
    scheduler = BackgroundScheduler(timezone="Asia/Kolkata")
    scheduler.add_job(
        scheduled_job,
        trigger=CronTrigger(minute="0,15,30,45"),
        id="xweather_15min_job",
        replace_existing=True,
        misfire_grace_time=120,
        coalesce=True,
        max_instances=1,
    )

    for capture_time in CAPTURE_TIMES:
        hour_str, minute_str = capture_time.split(":")
        scheduler.add_job(
            capture_snapshot_job,
            trigger=CronTrigger(hour=int(hour_str), minute=int(minute_str)),
            id=f"snapshot_{capture_time.replace(':', '')}",
            args=[capture_time],
            replace_existing=True,
            misfire_grace_time=300,
            coalesce=True,
            max_instances=1,
        )

    last_hour, last_minute = map(int, CAPTURE_TIMES[-1].split(":"))
    report_minute = (last_minute + 30) % 60
    report_hour = last_hour + (1 if last_minute + 30 >= 60 else 0)
    scheduler.add_job(
        daily_report_job,
        trigger=CronTrigger(hour=report_hour, minute=report_minute),
        id="daily_report_job",
        replace_existing=True,
        misfire_grace_time=600,
        coalesce=True,
        max_instances=1,
    )

    scheduler.start()
    print(
        "Scheduler started: 15-min continuous logging (all sites) + "
        f"{len(CAPTURE_TIMES)} fixed daily snapshot captures for {PILOT_SITES}, "
        f"+ daily report build at {report_hour:02d}:{report_minute:02d} (Asia/Kolkata)."
    )