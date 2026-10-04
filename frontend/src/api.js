// ---- localStorage cache helpers ----
// Matches the scheduler's 15-min Xweather refresh cycle, so we don't
// hit the backend more often than the data actually changes.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_PREFIX = 'swara_weather_xweather_cache_';

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    if (Date.now() - savedAt > CACHE_TTL_MS) return null; // stale
    return data;
  } catch {
    return null; // corrupted entry / storage disabled — just ignore it
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ data, savedAt: Date.now() })
    );
  } catch {
    // storage full or unavailable (private browsing) — fail silently
  }
}

export async function fetchSites() {
  const res = await fetch(`/api/sites`);
  if (!res.ok) throw new Error(`Failed to load sites (${res.status})`);
  return res.json();
}

export async function fetchWeather(siteName, { forceRefresh = false } = {}) {
  const cacheKey = `weather_${siteName}`;

  if (!forceRefresh) {
    const cached = readCache(cacheKey);
    if (cached) return cached;
  }

  const res = await fetch(`/api/weather?site=${encodeURIComponent(siteName)}`);
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('application/json')) {
    throw new Error(`Backend returned ${res.status} ${res.statusText} (non-JSON response)`);
  }
  const data = await res.json();
  writeCache(cacheKey, data);
  return data;
}

export async function fetchForecastLog(siteName, dateStr) {
  const params = new URLSearchParams({ site: siteName });
  if (dateStr) params.set('date', dateStr);
  const res = await fetch(`/api/forecast-log?${params.toString()}`);
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('application/json')) {
    throw new Error(`Backend returned ${res.status} ${res.statusText} (non-JSON response)`);
  }
  return res.json();
}