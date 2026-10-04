import { useState, useEffect, useCallback, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { fetchWeather } from './api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const SITES = ["KOTHAGUDEM", "SIRMOUR"];

const START_HOUR = 5;   // 5 AM
const END_HOUR = 21;    // 9 PM
const INTERVAL_MIN = 15;
const AUTO_REFRESH_MS = 15 * 60 * 1000; // auto re-fetch every 15 min, matches backend scheduler

// Every parameter Xweather actually returns for this feed, in one place —
// drives the sidebar checkboxes, the "All Parameters" dropdown, and the
// Forecast Graph datasets, so adding/removing a parameter only means
// editing this list.
const PARAMS = [
  { key: 'ghi', label: 'GHI', unit: 'W/m²', color: '#F5A623', group: 'solar' },
  { key: 'dni', label: 'DNI', unit: 'W/m²', color: '#FBBF24', group: 'solar' },
  { key: 'dhi', label: 'DHI', unit: 'W/m²', color: '#F97316', group: 'solar' },
  { key: 'temperature', label: 'Temperature', unit: '°C', color: '#EC4899', group: 'solar' },
  { key: 'humidity', label: 'Humidity', unit: '%', color: '#A78BFA', group: 'solar' },
  { key: 'poaGlobal', label: 'POA', unit: 'W/m²', color: '#34D399', group: 'solar' },
  { key: 'windSpeed', label: 'Wind Speed', unit: 'm/s', color: '#22D3EE', group: 'wind' },
];
const PARAM_BY_KEY = Object.fromEntries(PARAMS.map(p => [p.key, p]));

function pad(n) { return String(n).padStart(2, '0'); }

// SheetJS (cellDates: true) converts Excel's fractional-day time values using
// floating-point math, which often lands a fraction of a second short — e.g.
// 07:15:00 becomes 07:14:59.987. getHours()/getMinutes() TRUNCATE rather than
// round, so every timestamp from an xlsx upload would display ~1 minute early.
// Rounding to the nearest minute before formatting fixes this.
function roundToMinute(date) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  if (date.getSeconds() >= 30) rounded.setMinutes(rounded.getMinutes() + 1);
  return rounded;
}

// Builds the FIXED full list of time slots: 05:00, 05:15, ... 21:00 (inclusive)
function buildFullTimeline() {
  const slots = [];
  const totalSlots = ((END_HOUR - START_HOUR) * 60) / INTERVAL_MIN + 1;
  for (let i = 0; i < totalSlots; i++) {
    const totalMinutes = START_HOUR * 60 + i * INTERVAL_MIN;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    slots.push({ label: `${pad(hour)}:${pad(minute)}`, date });
  }
  return slots;
}

// Rounds "now" UP to the next 15-minute boundary strictly after now
// (15:52 -> 16:00, 16:07 -> 16:15). This MUST match the backend's
// _next_15min_boundary() in xweather_service.py exactly — that's where
// the real forecast data actually starts. Previously this floored
// instead of ceiling, which left a gap between "now" and where real
// data began; interpolateValue() flat-carries the first real point
// backward across that gap, which is what caused the flat plateau
// artifact right after the zero/data boundary.
function getRoundedNow() {
  const now = new Date();
  const flooredMinutes = Math.floor(now.getMinutes() / 15) * 15;
  now.setMinutes(flooredMinutes, 0, 0);
  now.setMinutes(now.getMinutes() + 15);
  return now;
}

const tooltipOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    tooltip: {
      mode: 'index',
      intersect: false,
      backgroundColor: '#0f172a',
      titleColor: '#38bdf8',
      bodyColor: '#e2e8f0',
      borderColor: '#1e293b',
      borderWidth: 1,
      padding: 10,
    },
    legend: { position: 'top', labels: { boxWidth: 12, usePointStyle: true, pointStyle: 'circle' } },
  },
  scales: {
    x: { ticks: { autoSkip: false, maxRotation: 90, minRotation: 60 }, grid: { color: 'rgba(148,163,184,0.15)' } },
    y: { grid: { color: 'rgba(148,163,184,0.15)' } },
  },
};

export default function App() {
  const [site, setSite] = useState(SITES[0]);
  const [forecast, setForecast] = useState([]);
  const [gridWeather, setGridWeather] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState(null);
  const [csvRows, setCsvRows] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [solarOpen, setSolarOpen] = useState(true);
  const [windOpen, setWindOpen] = useState(true);
  // Which parameter the "Forecast vs Actual" chart shows.
  // 'all' = every parameter combined on one graph (default, as soon as a file is loaded).
  // 'temp' | 'poa' | 'ghi' = only that parameter's Forecast + Actual pair.
  const [chart2Metric, setChart2Metric] = useState('all');

  // Sidebar checkboxes: which parameters are switched on for the Forecast Graph.
  const [checkedParams, setCheckedParams] = useState(
    () => Object.fromEntries(PARAMS.map(p => [p.key, true]))
  );
  // The "All Parameters" dropdown above the Forecast Graph. 'all' respects
  // the sidebar checkboxes; a specific key isolates just that one line —
  // same behaviour as the reference Meteosource dashboard's picker.
  const [chart1Filter, setChart1Filter] = useState('all');
  const [paramMenuOpen, setParamMenuOpen] = useState(false);
  const paramMenuRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (paramMenuRef.current && !paramMenuRef.current.contains(e.target)) {
        setParamMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const toggleParam = (key) => {
    setCheckedParams(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // The sidebar's width change is a CSS transition, so the chart's container
  // keeps resizing for ~300ms after the click. Chart.js's own ResizeObserver
  // mostly keeps up, but nudging it once more right after the transition ends
  // guarantees the canvas lands at the final full width instead of stopping
  // a few pixels short.
  const toggleSidebar = () => {
    setSidebarOpen(o => !o);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
  };

  const handleFetch = useCallback(async (forceRefresh = false) => {
    setStatus(forceRefresh ? 'Refreshing...' : 'Fetching...');
    setError(null);
    try {
      const data = await fetchWeather(site, { forceRefresh });
      setForecast(data.forecast || []);
      setGridWeather(data.gridWeather || null);
      setBlocked(data.blocked || null);
      setStatus('Fetch succeeded');
    } catch (e) {
      setError(e.message);
      setStatus('Fetch failed');
    }
  }, [site]);

  // Auto-fetch: runs once immediately whenever the selected site changes
  // (using cache if it's fresh), then forces a live refresh every 15 min
  // to match the backend scheduler — no manual click needed. Every call
  // still goes through fetchWeather(), which writes to localStorage.
  useEffect(() => {
    handleFetch(false);
    const intervalId = setInterval(() => {
      handleFetch(true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, [handleFetch]);

  // Parses the fixed "Site vs Weather" template:
  // Timestamp | Ambient Temperature (C) | POA(W/m2) | GHI_W (W/m2) | Temparature | POA_Global | GHI | POA_Diffuse | POA_Direct
  // Left 3 columns (Ambient Temp / POA / GHI_W) = actual site-sensor readings — POA is a
  // SINGLE real value from the site. The forecast side gives Temp + GHI plus POA broken
  // into three components (Global, Diffuse, Direct) for that same timestamp. Both sides
  // come from this single file — no merging with the live QWeather state.
  const extractRows = (rawRows) => {
    if (!rawRows || !rawRows.length) return null;
    const keys = Object.keys(rawRows[0]);

    const findExact = (name) => keys.find(k => k.trim().toLowerCase() === name);
    const findIncl = (subs, excl = []) => keys.find(k => {
      const low = k.toLowerCase();
      return subs.every(s => low.includes(s)) && excl.every(s => !low.includes(s));
    });

    const timeKey = findExact('timestamp') || findIncl(['time']);
    const siteTempKey = findIncl(['ambient', 'temp']);
    // Site POA is the one plain "POA(W/m2)" column — exclude the forecast's
    // Global/Diffuse/Direct POA columns so this only matches the site sensor.
    const sitePoaKey = findIncl(['poa'], ['global', 'diffuse', 'direct']);
    const siteGhiKey = findIncl(['ghi', 'w']);       // "GHI_W (W/m2)"
    const fcTempKey = findExact('temparature') || findIncl(['temp'], ['ambient']);
    const fcGhiKey = findExact('ghi');                // plain "GHI"
    const fcPoaGlobalKey = findIncl(['poa', 'global']);   // "POA_Global"
    const fcPoaDiffuseKey = findIncl(['poa', 'diffuse']); // "POA_Diffuse"
    const fcPoaDirectKey = findIncl(['poa', 'direct']);   // "POA_Direct"

    if (!timeKey || (!siteGhiKey && !sitePoaKey)) return null;

    return rawRows
      .map(r => {
        const rawTime = r[timeKey];
        const parsedDate = rawTime instanceof Date ? rawTime : new Date(rawTime);
        if (isNaN(parsedDate.getTime())) return null;
        const dateObj = roundToMinute(parsedDate);
        return {
          time: dateObj,
          label: `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`,
          ghiActual: siteGhiKey ? r[siteGhiKey] : null,
          poaActual: sitePoaKey ? r[sitePoaKey] : null,
          tempActual: siteTempKey ? r[siteTempKey] : null,
          ghiForecast: fcGhiKey ? r[fcGhiKey] : null,
          tempForecast: fcTempKey ? r[fcTempKey] : null,
          poaForecastGlobal: fcPoaGlobalKey ? r[fcPoaGlobalKey] : null,
          poaForecastDiffuse: fcPoaDiffuseKey ? r[fcPoaDiffuseKey] : null,
          poaForecastDirect: fcPoaDirectKey ? r[fcPoaDirectKey] : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileError(null);
    setCsvRows(null);

    const name = file.name.toLowerCase();

    if (name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = extractRows(results.data);
          if (!rows) {
            setFileError(
              `No GHI/POA columns found. Columns detected: ${Object.keys(results.data[0] || {}).join(', ') || 'none'}`
            );
            return;
          }
          setCsvRows(rows);
        },
        error: (err) => setFileError(`CSV parse error: ${err.message}`),
      });
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
          const rows = extractRows(json);
          if (!rows) {
            setFileError(
              `No GHI/POA columns found. Columns detected: ${Object.keys(json[0] || {}).join(', ') || 'none'}`
            );
            return;
          }
          setCsvRows(rows);
        } catch (err) {
          setFileError(`Excel parse error: ${err.message}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setFileError('Unsupported file type. Please upload a .csv or .xlsx file.');
    }
  };

  // --- Fixed full timeline: always 5 AM -> 9 PM, 15-min steps ---
  const timeline = buildFullTimeline();
  const windowStart = getRoundedNow();

  // Forecast points sorted by their REAL timestamp (Date object math, not
  // string labels). Matching by "HH:MM" string was fragile against any
  // browser/backend timezone edge case — a slot that didn't line up
  // exactly fell back to 0, which is why every trace was zeroing out
  // between spikes instead of varying smoothly.
  const sortedForecast = forecast
    .map(p => ({ ...p, dateObj: new Date(p.time) }))
    .filter(p => !isNaN(p.dateObj.getTime()))
    .sort((a, b) => a.dateObj - b.dateObj);

  // Linearly interpolates between the two forecast points bracketing time
  // `t`, so every 15-min slot gets a real, smoothly-varying value even if
  // it doesn't land exactly on a returned forecast timestamp.
  function interpolateValue(t, field) {
    if (!sortedForecast.length) return null;
    if (t <= sortedForecast[0].dateObj) return sortedForecast[0][field] ?? null;
    const last = sortedForecast[sortedForecast.length - 1];
    if (t >= last.dateObj) return last[field] ?? null;

    let lo = 0, hi = sortedForecast.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sortedForecast[mid].dateObj <= t) lo = mid; else hi = mid;
    }
    const a = sortedForecast[lo], b = sortedForecast[hi];
    const av = a[field], bv = b[field];
    if (av == null || bv == null) return av ?? bv ?? null;
    const span = b.dateObj - a.dateObj;
    if (span <= 0) return av;
    const frac = (t - a.dateObj) / span;
    return av + (bv - av) * frac;
  }

  // Helper: returns 0 for any time before "now", real interpolated forecast value from "now" onward
  const valueForTime = (t, field) => {
    if (t.date < windowStart) return 0;
    const v = interpolateValue(t.date, field);
    return v != null ? v : 0;
  };

  const chart1Labels = timeline.map(t => t.label);

  // Which parameters actually render on the Forecast Graph: the top-right
  // dropdown either isolates one parameter or (on 'all') falls back to
  // whatever's switched on in the sidebar.
  const activeParams = chart1Filter === 'all'
    ? PARAMS.filter(p => checkedParams[p.key])
    : PARAMS.filter(p => p.key === chart1Filter);

  const chart1Data = {
    labels: chart1Labels,
    datasets: activeParams.map(p => ({
      label: `${p.label} (${p.unit})`,
      data: timeline.map(t => valueForTime(t, p.key)),
      borderColor: p.color,
      backgroundColor: p.color,
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.35,
    })),
  };

  const showingLabel = chart1Filter === 'all' ? 'All Parameters' : PARAM_BY_KEY[chart1Filter].label;

  // Forecast-vs-actual chart — built ENTIRELY from the uploaded file.
  // The file already carries both the weather-platform's forecast columns
  // and the site's actual sensor columns for the same timestamps, so this
  // no longer touches the live QWeather `forecast` state, the fixed
  // 5AM-9PM `timeline`, or `windowStart` above — those only drive Chart 1.
  // Temp and GHI each have one site value vs one forecast value. POA is
  // different: the site only reports ONE POA value, but the forecast
  // splits POA into three components (Global, Diffuse, Direct) — so the
  // site's single POA actual is compared against all three forecast parts.
  let chart2Data = null;
  let accuracy = null;
  if (csvRows && csvRows.length) {
    // Each metric's dataset(s), keyed so the dropdown can pick out just one
    // — or 'all' can concatenate every group together.
    const metricDatasets = {
      ghi: [
        {
          label: 'GHI Forecast (Weather Platform)',
          data: csvRows.map(r => r.ghiForecast ?? 0),
          borderColor: '#F5A623', backgroundColor: '#F5A623',
        },
        {
          label: 'GHI Actual (Site)',
          data: csvRows.map(r => r.ghiActual ?? 0),
          borderColor: '#F5A623', borderDash: [5, 5], backgroundColor: '#F5A623',
        },
      ],
      temp: [
        {
          label: 'Temperature Forecast (Weather Platform)',
          data: csvRows.map(r => r.tempForecast ?? 0),
          borderColor: '#F87171', backgroundColor: '#F87171',
        },
        {
          label: 'Temperature Actual (Site)',
          data: csvRows.map(r => r.tempActual ?? 0),
          borderColor: '#F87171', borderDash: [5, 5], backgroundColor: '#F87171',
        },
      ],
      // Combined view: site's single POA actual vs. all three forecast components.
      poa: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#38BDF8', borderDash: [5, 5], backgroundColor: '#38BDF8',
        },
        {
          label: 'POA Global Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastGlobal ?? 0),
          borderColor: '#38BDF8', backgroundColor: '#38BDF8',
        },
        {
          label: 'POA Diffuse Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDiffuse ?? 0),
          borderColor: '#A78BFA', backgroundColor: '#A78BFA',
        },
        {
          label: 'POA Direct Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDirect ?? 0),
          borderColor: '#22D3EE', backgroundColor: '#22D3EE',
        },
      ],
      // Individual POA-component views: site actual vs just that one forecast part.
      poaGlobal: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#38BDF8', borderDash: [5, 5], backgroundColor: '#38BDF8',
        },
        {
          label: 'POA Global Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastGlobal ?? 0),
          borderColor: '#38BDF8', backgroundColor: '#38BDF8',
        },
      ],
      poaDiffuse: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#A78BFA', borderDash: [5, 5], backgroundColor: '#A78BFA',
        },
        {
          label: 'POA Diffuse Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDiffuse ?? 0),
          borderColor: '#A78BFA', backgroundColor: '#A78BFA',
        },
      ],
      poaDirect: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#22D3EE', borderDash: [5, 5], backgroundColor: '#22D3EE',
        },
        {
          label: 'POA Direct Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDirect ?? 0),
          borderColor: '#22D3EE', backgroundColor: '#22D3EE',
        },
      ],
    };

    const selectedDatasets = chart2Metric === 'all'
      ? [...metricDatasets.ghi, ...metricDatasets.temp, ...metricDatasets.poa]
      : metricDatasets[chart2Metric];

    chart2Data = {
      labels: csvRows.map(r => r.label),
      datasets: selectedDatasets,
    };

    // Full forecast-performance stats per parameter/component:
    //   MAE   — mean absolute error, in the parameter's own unit
    //   RMSE  — root-mean-square error, in the parameter's own unit (penalizes big misses more)
    //   nMAE  — MAE normalized by the mean actual value, as a % (unit-free, comparable across parameters)
    //   MAPE  — mean absolute percentage error (skips rows where actual is 0, to avoid /0)
    //   Accuracy % — the intuitive "how correct was it" read, 100 - MAPE, clamped at 0
    const statsFor = (forecastKey, actualKey) => {
      const pairs = [];
      csvRows.forEach(r => {
        const f = r[forecastKey];
        const a = r[actualKey];
        if (f != null && a != null && a !== '') pairs.push({ f: Number(f), a: Number(a) });
      });
      if (!pairs.length) return null;

      const n = pairs.length;
      const mae = pairs.reduce((sum, p) => sum + Math.abs(p.f - p.a), 0) / n;
      const rmse = Math.sqrt(pairs.reduce((sum, p) => sum + (p.f - p.a) ** 2, 0) / n);
      const meanActual = pairs.reduce((sum, p) => sum + p.a, 0) / n;
      const nmae = meanActual ? (mae / meanActual) * 100 : null;

      const pctErrors = pairs.filter(p => p.a !== 0).map(p => Math.abs((p.f - p.a) / p.a));
      const mape = pctErrors.length ? (pctErrors.reduce((sum, e) => sum + e, 0) / pctErrors.length) * 100 : null;
      const accuracyPct = mape != null ? Math.max(0, 100 - mape) : null;

      return {
        mae: mae.toFixed(2),
        rmse: rmse.toFixed(2),
        nmae: nmae != null ? nmae.toFixed(2) : '—',
        mape: mape != null ? mape.toFixed(2) : '—',
        accuracyPct: accuracyPct != null ? accuracyPct.toFixed(1) : '—',
      };
    };

    const showGhi = chart2Metric === 'all' || chart2Metric === 'ghi';
    const showTemp = chart2Metric === 'all' || chart2Metric === 'temp';
    const showPoaGlobal = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaGlobal';
    const showPoaDiffuse = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaDiffuse';
    const showPoaDirect = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaDirect';

    const ghiStats = showGhi ? statsFor('ghiForecast', 'ghiActual') : null;
    const tempStats = showTemp ? statsFor('tempForecast', 'tempActual') : null;
    const poaGlobalStats = showPoaGlobal ? statsFor('poaForecastGlobal', 'poaActual') : null;
    const poaDiffuseStats = showPoaDiffuse ? statsFor('poaForecastDiffuse', 'poaActual') : null;
    const poaDirectStats = showPoaDirect ? statsFor('poaForecastDirect', 'poaActual') : null;

    if (ghiStats || tempStats || poaGlobalStats || poaDiffuseStats || poaDirectStats) {
      accuracy = { ghiStats, tempStats, poaGlobalStats, poaDiffuseStats, poaDirectStats };
    }
  }

  const statusTone =
    status === 'Fetch succeeded' ? 'success' :
    status === 'Fetch failed' ? 'error' :
    (status === 'Fetching...' || status === 'Refreshing...') ? 'pending' : 'idle';

  const statusStyles = {
    success: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30',
    error: 'bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/30',
    pending: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/30',
    idle: 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/30',
  };
  const dotStyles = {
    success: 'bg-emerald-400',
    error: 'bg-rose-400',
    pending: 'bg-amber-400 animate-pulse',
    idle: 'bg-slate-400',
  };

  const accuracyCards = accuracy ? [
    accuracy.tempStats && { label: 'Temperature Accuracy', value: accuracy.tempStats.accuracyPct, color: 'text-rose-400', border: 'border-rose-500/30' },
    accuracy.ghiStats && { label: 'GHI Accuracy', value: accuracy.ghiStats.accuracyPct, color: 'text-amber-400', border: 'border-amber-500/30' },
    accuracy.poaGlobalStats && { label: 'POA Global Accuracy', value: accuracy.poaGlobalStats.accuracyPct, color: 'text-sky-400', border: 'border-sky-500/30' },
    accuracy.poaDiffuseStats && { label: 'POA Diffuse Accuracy', value: accuracy.poaDiffuseStats.accuracyPct, color: 'text-violet-400', border: 'border-violet-500/30' },
    accuracy.poaDirectStats && { label: 'POA Direct Accuracy', value: accuracy.poaDirectStats.accuracyPct, color: 'text-cyan-400', border: 'border-cyan-500/30' },
  ].filter(Boolean) : [];

  // Row data for the "Forecast Performance Evaluation" table — one row per
  // parameter/component, each with its own unit and accent color (matching
  // the accuracy chips below the chart). Table sits above the Forecast vs
  // Actual chart. Rows only appear once a comparison file is loaded and that
  // parameter/component has enough paired data to score.
  const performanceRows = accuracy ? [
    accuracy.tempStats && { label: 'Temperature', unit: '°C', color: 'text-rose-400', stats: accuracy.tempStats },
    accuracy.ghiStats && { label: 'GHI', unit: 'W/m²', color: 'text-amber-400', stats: accuracy.ghiStats },
    accuracy.poaGlobalStats && { label: 'POA Global', unit: 'W/m²', color: 'text-sky-400', stats: accuracy.poaGlobalStats },
    accuracy.poaDiffuseStats && { label: 'POA Diffuse', unit: 'W/m²', color: 'text-violet-400', stats: accuracy.poaDiffuseStats },
    accuracy.poaDirectStats && { label: 'POA Direct', unit: 'W/m²', color: 'text-cyan-400', stats: accuracy.poaDirectStats },
  ].filter(Boolean) : [];

  return (
    <div className="h-screen overflow-hidden bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100 flex flex-col">
      {/* ---------- Top bar ---------- */}
      {/* This bar sits outside the scrolling area below, so it never moves —
          no need for "sticky", which was fighting the new fixed-height shell. */}
      <header className="shrink-0 border-b border-slate-800/80 bg-slate-950/90">
        <div className="px-6 py-2.5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-400 to-sky-600 flex items-center justify-center shadow-lg shadow-cyan-900/40 shrink-0">
              <svg viewBox="0 0 24 24" className="w-6 h-6 text-slate-950" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4-2.5A5 5 0 0 0 6.5 17h11z" />
                <path d="M12 3v1" />
                <path d="M4 10l1 .5" />
                <path d="M19 6l-1 1" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight leading-tight">Vaisala Xweather Dashboard</h1>
              <p className="text-xs text-slate-400">Live solar &amp; wind site intelligence · <span className="text-slate-300 font-medium">{site}</span></p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* All Parameters dropdown — drives the Forecast Graph below */}
            <div className="relative" ref={paramMenuRef}>
              <button
                onClick={() => setParamMenuOpen(o => !o)}
                className="flex items-center gap-2 text-sm bg-slate-800/80 hover:bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 transition-colors duration-200"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M6 12h12M10 18h4" />
                </svg>
                <span>{showingLabel}</span>
                <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${paramMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {paramMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 overflow-hidden animate-[fadeIn_0.15s_ease-in-out] z-40">
                  <button
                    onClick={() => { setChart1Filter('all'); setParamMenuOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-700/80 transition-colors ${chart1Filter === 'all' ? 'bg-cyan-500/10 text-cyan-300' : 'text-slate-200'}`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-cyan-400 to-sky-500 shrink-0" />
                    All Parameters
                  </button>
                  <div className="h-px bg-slate-700" />
                  {PARAMS.map(p => (
                    <button
                      key={p.key}
                      onClick={() => { setChart1Filter(p.key); setParamMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-700/80 transition-colors ${chart1Filter === p.key ? 'bg-cyan-500/10 text-cyan-300' : 'text-slate-200'}`}
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      {p.label} <span className="text-slate-500 text-xs">({p.unit})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Status pill */}
            <div className={`flex items-center gap-2 text-sm font-medium rounded-lg px-3 py-2 ${statusStyles[statusTone]}`}>
              <span className={`w-2 h-2 rounded-full ${dotStyles[statusTone]}`} />
              {status}
            </div>
          </div>
        </div>
      </header>

      {/* min-h-0 is what lets this row's children scroll internally instead of
          growing past the screen — without it the outer h-screen/overflow-hidden
          shell just gets pushed off-screen by its content. */}
      <div className="flex flex-1 min-h-0 relative">
        {/* ---------- Sidebar toggle ---------- */}
        <button
          onClick={toggleSidebar}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="absolute top-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white transition-all duration-300 ease-in-out shadow-md"
          style={{ left: sidebarOpen ? '19.5rem' : '0.75rem' }}
        >
          <span className={`inline-block transition-transform duration-300 ease-in-out ${sidebarOpen ? '' : 'rotate-180'}`}>
            ‹
          </span>
        </button>

        {/* ---------- Sidebar ---------- */}
        <div
          className={`bg-slate-900/60 border-r border-slate-800/80 flex flex-col gap-5 overflow-y-auto overflow-x-hidden
            transition-all duration-300 ease-in-out
            ${sidebarOpen ? 'w-80 p-6 opacity-100' : 'w-0 p-0 opacity-0'}`}
        >
          <div className="w-72 shrink-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-cyan-400/90">Dashboard Controls</p>
            <p className="text-sm text-slate-400 mt-0.5">Select a site and the parameters to track.</p>
          </div>

          <div className="w-72 shrink-0 bg-slate-800/70 border border-slate-700/60 rounded-xl p-3">
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Project Site</label>
            <select className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50" value={site} onChange={(e) => setSite(e.target.value)}>
              {SITES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="w-72 shrink-0 bg-slate-800/70 border border-slate-700/60 rounded-xl p-3">
            <button
              onClick={() => setSolarOpen(o => !o)}
              className="w-full flex items-center justify-between text-amber-400 font-semibold text-sm"
            >
              <span className="flex items-center gap-2">☀️ Solar Parameters</span>
              <span className={`transition-transform duration-300 ease-in-out ${solarOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            <div
              className={`grid transition-all duration-300 ease-in-out ${solarOpen ? 'grid-rows-[1fr] opacity-100 mt-2.5' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden flex flex-col gap-1.5">
                {PARAMS.filter(p => p.group === 'solar').map(p => (
                  <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer hover:text-white transition-colors">
                    <input
                      type="checkbox"
                      checked={checkedParams[p.key]}
                      onChange={() => toggleParam(p.key)}
                      className="accent-cyan-500 w-4 h-4"
                    />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                    {p.label} <span className="text-slate-500 text-xs">({p.unit})</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="w-72 shrink-0 bg-slate-800/70 border border-slate-700/60 rounded-xl p-3">
            <button
              onClick={() => setWindOpen(o => !o)}
              className="w-full flex items-center justify-between text-cyan-400 font-semibold text-sm"
            >
              <span className="flex items-center gap-2">💨 Wind Parameters</span>
              <span className={`transition-transform duration-300 ease-in-out ${windOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            <div
              className={`grid transition-all duration-300 ease-in-out ${windOpen ? 'grid-rows-[1fr] opacity-100 mt-2.5' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer hover:text-white transition-colors">
                  <input
                    type="checkbox"
                    checked={checkedParams.windSpeed}
                    onChange={() => toggleParam('windSpeed')}
                    className="accent-cyan-500 w-4 h-4"
                  />
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PARAM_BY_KEY.windSpeed.color }} />
                  Wind Speed <span className="text-slate-500 text-xs">(m/s)</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-500">
                  <input type="checkbox" disabled className="w-4 h-4" /> Wind Direction (not available)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-500">
                  <input type="checkbox" disabled className="w-4 h-4" /> Wind Gust (not available)
                </label>
              </div>
            </div>
          </div>

          {gridWeather && (
            <div className="w-72 shrink-0 bg-slate-800/70 border border-emerald-500/30 rounded-xl p-3 text-sm animate-[fadeIn_0.3s_ease-in-out]">
              <p className="text-emerald-400 font-semibold mb-1.5 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Grid Weather Live
              </p>
              <p className="text-slate-300">Wind Dir: {gridWeather.windDir} ({gridWeather.wind360}°)</p>
              <p className="text-slate-300">Gust: {gridWeather.windGust ?? 'No significant gust'}</p>
              <p className="text-slate-300">Cloud: {gridWeather.cloud}%</p>
              <p className="text-slate-300">Pressure: {gridWeather.pressure} hPa</p>
            </div>
          )}
          {blocked && !gridWeather && (
            <div className="w-72 shrink-0 bg-slate-800/70 border border-rose-500/20 rounded-xl p-3 text-xs text-slate-400">
              <p className="text-rose-400 font-semibold mb-1">Grid weather blocked</p>
              <p>{blocked.windDirection}</p>
            </div>
          )}

          <div className="w-72 shrink-0 bg-slate-800/70 border border-slate-700/60 rounded-xl p-3">
            <p className="text-xs font-medium text-slate-400 mb-2">Upload Site Sensor CSV/XLSX</p>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              className="text-xs w-full text-slate-300 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-slate-700 file:text-slate-100 hover:file:bg-slate-600 file:cursor-pointer cursor-pointer"
            />
            {fileError && <p className="text-rose-400 text-xs mt-1.5">{fileError}</p>}
            {csvRows && !fileError && (
              <p className="text-emerald-400 text-xs mt-1.5">Loaded {csvRows.length} rows</p>
            )}
          </div>

          <div className="w-72 shrink-0 flex gap-2">
            <button onClick={() => handleFetch(false)} className="flex-1 bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-slate-950 font-semibold rounded-lg py-2 transition-all duration-200 shadow-md shadow-cyan-900/30">
              Fetch
            </button>
            <button onClick={() => handleFetch(true)} title="Bypass cache and hit the backend directly" className="px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded-lg py-2 text-sm transition-colors duration-200">
              ↻
            </button>
          </div>

          <p className="w-72 shrink-0 text-xs text-slate-500 leading-relaxed">
            Auto-refreshes every 15 min · Axis: 05:00 → 21:00 (15-min steps) · Data fills from {pad(windowStart.getHours())}:{pad(windowStart.getMinutes())} onward, zero before that
          </p>
          {error && <p className="w-72 shrink-0 text-rose-400 text-sm">{error}</p>}
        </div>

        {/* ---------- Main content ---------- */}
        {/* This pane owns its own scrollbar (overflow-y-auto) so the Forecast
            Graph card below can be sized to the viewport and land fully on
            screen — including its x-axis — without the whole page scrolling.
            The second card (Forecast vs Actual) simply sits below it and is
            reached by scrolling within this pane, same as before. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-5 transition-all duration-300 ease-in-out">
          <div className="shrink-0 bg-slate-900/60 border border-slate-800/80 rounded-2xl shadow-lg shadow-black/20 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800/80 flex-wrap gap-2 shrink-0">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" /><path d="M18 9l-5 5-4-4-4 4" />
                </svg>
                Forecast Graph — {site}
              </h2>
              <span className="text-xs font-medium bg-slate-800 border border-slate-700 rounded-full px-3 py-1 text-slate-300">
                Showing: {showingLabel}
              </span>
            </div>
            {/* Fixed, viewport-relative height (not a fixed pixel count) so the
                whole plot — axes, legend and all — reliably fits on screen on
                first load on both laptop and desktop heights, and Chart.js
                (maintainAspectRatio: false, set above) fills exactly this box
                instead of forcing its own aspect ratio. */}
            {/* Fixed pixel height (not vh) so this graph always renders at
                exactly this size, regardless of window/screen height. */}
            <div className="bg-white p-4 h-[560px]">
              {forecast.length > 0
                ? <Line data={chart1Data} options={tooltipOptions} />
                : <p className="text-slate-500 text-center py-20">Select parameters and click Fetch to load real Xweather data.</p>}
            </div>
          </div>

          <div className="shrink-0 bg-slate-900/60 border border-slate-800/80 rounded-2xl shadow-lg shadow-black/20 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800/80 flex-wrap gap-2">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" /><path d="M7 15l3-3 3 3 5-6" />
                </svg>
                Forecast vs Actual <span className="text-slate-500 font-normal hidden sm:inline">(Temperature, GHI &amp; POA: Global/Diffuse/Direct)</span>
              </h2>
              {csvRows && csvRows.length > 0 && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400">Parameter:</label>
                  <select
                    className="bg-slate-800 text-slate-100 rounded-lg p-1.5 text-sm border border-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                    value={chart2Metric}
                    onChange={(e) => setChart2Metric(e.target.value)}
                  >
                    <option value="all">All (combined)</option>
                    <option value="temp">Temperature</option>
                    <option value="ghi">GHI</option>
                    <option value="poa">POA (All 3 vs Site)</option>
                    <option value="poaGlobal">POA Global</option>
                    <option value="poaDiffuse">POA Diffuse</option>
                    <option value="poaDirect">POA Direct</option>
                  </select>
                </div>
              )}
            </div>

            {performanceRows.length > 0 && (
              <div className="px-5 py-4 border-b border-slate-800/80 overflow-x-auto">
                <h3 className="text-sm font-semibold text-slate-200 mb-3">Forecast Performance Evaluation</h3>
                <table className="w-full text-sm border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-800">
                      <th className="py-2 pr-6 font-medium">Parameter</th>
                      <th className="py-2 pr-6 font-medium">MAE</th>
                      <th className="py-2 pr-6 font-medium">RMSE</th>
                      <th className="py-2 pr-6 font-medium">nMAE (%)</th>
                      <th className="py-2 pr-6 font-medium">MAPE (%)</th>
                      <th className="py-2 pr-6 font-medium">Accuracy (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performanceRows.map(row => (
                      <tr key={row.label} className="border-b border-slate-800/60 last:border-0">
                        <td className="py-2 pr-6 text-slate-200">{row.label}</td>
                        <td className={`py-2 pr-6 font-medium ${row.color}`}>{row.stats.mae} {row.unit}</td>
                        <td className={`py-2 pr-6 font-medium ${row.color}`}>{row.stats.rmse} {row.unit}</td>
                        <td className={`py-2 pr-6 font-medium ${row.color}`}>{row.stats.nmae}</td>
                        <td className={`py-2 pr-6 font-medium ${row.color}`}>{row.stats.mape}</td>
                        <td className="py-2 pr-6 font-medium text-emerald-300">{row.stats.accuracyPct}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="bg-white p-4 h-[75vh] min-h-[500px]">
              {chart2Data
                ? <Line data={chart2Data} options={tooltipOptions} />
                : <p className="text-slate-500 text-center py-20">Upload a site sensor CSV or XLSX to see the comparison.</p>}
            </div>
            {accuracyCards.length > 0 && (
              <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 border-t border-slate-800/80">
                {accuracyCards.map(c => (
                  <div key={c.label} className={`rounded-xl bg-slate-800/70 border ${c.border} px-3 py-2.5`}>
                    <p className="text-xs text-slate-400 mb-1">{c.label}</p>
                    <p className={`text-lg font-bold ${c.color}`}>{c.value}%</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
