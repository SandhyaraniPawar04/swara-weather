import os
import re
import csv
from datetime import datetime, timedelta, timezone

import pandas as pd

from config import (
    DATA_DIR, SNAPSHOT_DIR, PILOT_SITES, PILOT_SITE_DISPLAY_NAMES,
)

IST = timezone(timedelta(hours=5, minutes=30))

REPORT_PARAMS = [
    ("ghi", "ghi_{label}"),
    ("temperature", "temperature_{label}"),
    ("poaGlobal", "POA_Global_{label}"),
    ("poaDiffuse", "POA_Diffuse {label}"),
    ("poaDirect", "POA_Direct {label}"),
]

SNAPSHOT_FILENAME_RE = re.compile(r"_(\d{4})\.csv$")


def _capture_label(hhmm_tag):
    hour, minute = int(hhmm_tag[:2]), int(hhmm_tag[2:])
    hour12 = hour % 12
    if hour12 == 0:
        hour12 = 12
    return f"{hour12}:{minute:02d}"


def _find_snapshot_files(display_name, date_obj):
    site_dir = os.path.join(SNAPSHOT_DIR, display_name)
    if not os.path.isdir(site_dir):
        return []
    date_tag = date_obj.strftime("%Y-%m-%d")
    prefix = f"{display_name}_{date_tag}_"
    matches = []
    for fname in os.listdir(site_dir):
        if fname.startswith(prefix) and fname.endswith(".csv"):
            m = SNAPSHOT_FILENAME_RE.search(fname)
            if m:
                matches.append((m.group(1), os.path.join(site_dir, fname)))
    matches.sort(key=lambda pair: pair[0])
    return matches


def _load_snapshot_series(file_path, value_col):
    times, values = [], []
    with open(file_path, newline="") as f:
        reader = csv.DictReader(f)
        if value_col not in (reader.fieldnames or []):
            return None
        for row in reader:
            try:
                t = pd.Timestamp(row["time"])
                if t.tzinfo is None:
                    t = t.tz_localize(IST)
                v = row.get(value_col)
                values.append(float(v) if v not in (None, "") else None)
                times.append(t)
            except (ValueError, KeyError):
                continue
    if not times:
        return None
    return pd.Series(values, index=pd.DatetimeIndex(times)).sort_index()


def _interpolate_to_grid(series, target_index):
    if series is None:
        return pd.Series([None] * len(target_index), index=target_index)
    combined_index = series.index.union(target_index)
    combined = series.reindex(combined_index).astype(float)
    combined = combined.interpolate(method="time", limit_area="inside")
    return combined.reindex(target_index)


def build_daily_report(site_key, date_obj=None):
    display_name = PILOT_SITE_DISPLAY_NAMES.get(site_key, site_key)
    date_obj = date_obj or datetime.now(IST).date()

    captures = _find_snapshot_files(display_name, date_obj)
    if not captures:
        print(f"[report_builder] No snapshots found for {site_key} on {date_obj} — skipping.")
        return None

    start = pd.Timestamp(datetime.combine(date_obj, datetime.min.time()), tz=IST) + pd.Timedelta(hours=7)
    end = start + pd.Timedelta(hours=23, minutes=45)
    target_index = pd.date_range(start=start, end=end, freq="15min")

    columns = {}
    for hhmm_tag, file_path in captures:
        label = _capture_label(hhmm_tag)
        for value_col, label_template in REPORT_PARAMS:
            series = _load_snapshot_series(file_path, value_col)
            columns[label_template.format(label=label)] = _interpolate_to_grid(series, target_index)

    df = pd.DataFrame(columns, index=target_index)
    df.insert(0, "time", [t.isoformat() for t in target_index])
    numeric_cols = [c for c in df.columns if c != "time"]
    df[numeric_cols] = df[numeric_cols].round(2)

    out_dir = os.path.join(DATA_DIR, site_key)
    os.makedirs(out_dir, exist_ok=True)
    date_tag = f"{date_obj.day}_{date_obj.strftime('%B').lower()}_{date_obj.year}"
    out_path = os.path.join(out_dir, f"24_hrs_{display_name}_{date_tag}.csv")

    df.to_csv(out_path, index=False)
    print(f"[report_builder] Wrote {out_path} ({len(captures)} captures, {len(df)} rows)")
    return out_path


def build_reports_for_all_pilot_sites(date_obj=None):
    for site_key in PILOT_SITES:
        try:
            build_daily_report(site_key, date_obj)
        except Exception as e:
            print(f"[report_builder] FAILED for {site_key}: {type(e).__name__}: {e}")