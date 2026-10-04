import os
from dotenv import load_dotenv

load_dotenv()

XWEATHER_CLIENT_ID = os.getenv("XWEATHER_CLIENT_ID")
XWEATHER_CLIENT_SECRET = os.getenv("XWEATHER_CLIENT_SECRET")
XWEATHER_API_HOST = os.getenv("XWEATHER_API_HOST", "data.api.xweather.com")
FLASK_PORT = int(os.getenv("FLASK_PORT", 5000))

XWEATHER_FORECAST_PATH = os.getenv("XWEATHER_FORECAST_PATH", "/forecasts/{lat},{lon}")

SITES = {
    "BHUPALPALLY": {"lat": 18.447931, "lon": 79.877263, "tilt": 20, "azimuth": 180},
    "KASIPET": {"lat": 19.03943918, "lon": 79.43691745, "tilt": 20, "azimuth": 180},
    "KOTHAGUDEM": {"lat": 17.52500925, "lon": 80.64616743, "tilt": 20, "azimuth": 180},
    "OSEPL": {"lat": 17.9068, "lon": 76.3229, "tilt": 20, "azimuth": 180},
    "SIRMOUR": {"lat": 24.56253056, "lon": 75.09140278, "tilt": 20, "azimuth": 180},
    "ANJANGAON": {"lat": 21.975834, "lon": 75.96833, "tilt": 20, "azimuth": 180},
}

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

PILOT_SITES = ["KOTHAGUDEM", "SIRMOUR"]

PILOT_SITE_DISPLAY_NAMES = {
    "KOTHAGUDEM": "Kothagudem",
    "SIRMOUR": "Sirmour",
}

CAPTURE_TIMES = [
    "06:45", "08:15", "09:45", "11:15", "13:51", "14:15",
    "15:45"
]

SNAPSHOT_DIR = os.path.join(os.path.dirname(__file__), "forecast")