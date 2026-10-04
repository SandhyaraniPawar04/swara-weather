import csv
import os
from datetime import datetime

from flask import Flask, jsonify, request
from flask_cors import CORS

from config import SITES, FLASK_PORT, DATA_DIR
from xweather_service import fetch_solar_forecast, fetch_solar_forecast_15min
from scheduler import start_scheduler, log_forecast_to_csv

app = Flask(__name__)
CORS(app)  # allow the React dev server (localhost:4001) to call this backend


def _to_float(val):
    try:
        return float(val) if val not in (None, "") else None
    except ValueError:
        return None


@app.route("/api/sites", methods=["GET"])
def get_sites():
    return jsonify([
        {"name": name, "lat": s["lat"], "lon": s["lon"]}
        for name, s in SITES.items()
    ])


@app.route("/api/weather", methods=["GET"])
def get_weather():
    site_name = request.args.get("site")
    lat = request.args.get("lat")
    lon = request.args.get("lon")

    if site_name and site_name in SITES:
        site = SITES[site_name]
        lat, lon, tilt, azimuth = site["lat"], site["lon"], site["tilt"], site["azimuth"]
    elif lat and lon:
        lat, lon = float(lat), float(lon)
        tilt, azimuth = 20, 180
    else:
        return jsonify({"error": "Provide either 'site' or 'lat'+'lon'"}), 400

    try:
        points = fetch_solar_forecast_15min(lat, lon, tilt=tilt, azimuth=azimuth)
    except Exception as e:
        return jsonify({"error": f"Xweather solar request failed: {str(e)}"}), 502

    if site_name:
        log_forecast_to_csv(site_name, points)

    response = {
        "site": site_name,
        "lat": lat,
        "lon": lon,
        "forecast": points,
    }

    return jsonify(response)


@app.route("/api/forecast-log", methods=["GET"])
def get_forecast_log():
    site_name = request.args.get("site")
    date_str = request.args.get("date")  # optional, format: DD_Month_YYYY

    if not site_name or site_name not in SITES:
        return jsonify({"error": "Provide a valid 'site'"}), 400

    if not date_str:
        date_str = datetime.now().strftime("%d_%B_%Y")

    file_path = os.path.join(DATA_DIR, site_name, f"{date_str}.csv")

    if not os.path.isfile(file_path):
        return jsonify({"site": site_name, "date": date_str, "forecast": []})

    rows = []
    with open(file_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "time": row.get("time"),
                "ghi": _to_float(row.get("ghi")),
                "dni": _to_float(row.get("dni")),
                "dhi": _to_float(row.get("dhi")),
                "temperature": _to_float(row.get("temperature")),
                "windSpeed": _to_float(row.get("windSpeed")),
                "humidity": _to_float(row.get("humidity")),
                "poaGlobal": _to_float(row.get("poaGlobal")),
                "poaDirect": _to_float(row.get("poaDirect")),
                "poaDiffuse": _to_float(row.get("poaDiffuse")),
                "callAt": row.get("call_at"),
            })

    return jsonify({"site": site_name, "date": date_str, "forecast": rows})


if __name__ == "__main__":
    start_scheduler()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)