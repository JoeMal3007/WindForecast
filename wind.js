const MS_TO_KT = 1.9438444924;

// Endpoint GFS/NOAA da Open-Meteo.
// O endpoint /v1/gfs força o uso da família GFS/NOAA.
const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/gfs";
// Use the standard Open-Meteo forecast endpoint only for hourly visibility.
// On some devices/GFS responses, visibility can appear stale across hours;
// this separate request gives a clean hourly visibility series to merge by time.
const OPEN_METEO_VISIBILITY_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

// Tentativas para a API de metadata/update do Open-Meteo. A API já documenta os
// campos last_run_initialisation_time, last_run_modification_time e
// last_run_availability_time, mas a forma exata do JSON pode variar entre modelos.
const OPEN_METEO_MODEL_UPDATE_URLS = [
  "https://api.open-meteo.com/v1/model-updates?models=gfs_seamless",
  "https://api.open-meteo.com/v1/model-updates?model=gfs_seamless",
  "https://api.open-meteo.com/v1/model-updates?models=gfs_global",
  "https://api.open-meteo.com/v1/model-updates?model=gfs_global",
  "https://api.open-meteo.com/v1/model-updates"
];

// NOAA SWPC planetary Kp data. Independent of selected map location.
// The app uses the latest valid kp_index from this file.
const SWPC_KP_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const SWPC_KP_FALLBACK_PROXY = "https://api.allorigins.win/raw?url=" + encodeURIComponent(SWPC_KP_URL);

// GFZ/Potsdam Kp forecast. Used only when a future hour is selected.
const GFZ_KP_FORECAST_URL = "https://spaceweather.gfz.de/fileadmin/Kp-Forecast/CSV/kp_product_file_FORECAST_PAGER_SWIFT_LAST.json";
const KP_CACHE_MS = 5 * 60 * 1000;
let gfzKpRowsCache = null;
let gfzKpRowsCacheTime = 0;
let latestSwpcKpCache = null;
let latestSwpcKpCacheTime = 0;


function toKt(ms){
  return ms * MS_TO_KT;
}

function degToCardinal(deg){
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(((((deg % 360) + 360) % 360) / 45)) % 8];
}

function circularInterpolateDeg(d1,d2,t){
  let delta = ((((d2 - d1) % 360) + 540) % 360) - 180;
  return (d1 + delta * t + 360) % 360;
}

function interpolate(a,b,target){
  const t = (target - a.altitude) / (b.altitude - a.altitude);
  return {
    altitude: target,
    speed: a.speed + (b.speed - a.speed) * t,
    direction: circularInterpolateDeg(a.direction, b.direction, t)
  };
}

function extrapolate(a,b,target){
  const t = (target - a.altitude) / (b.altitude - a.altitude);
  return {
    altitude: target,
    speed: Math.max(0, a.speed + (b.speed - a.speed) * t),
    direction: circularInterpolateDeg(a.direction, b.direction, t)
  };
}

function buildTargetLevels(raw){
  const p10 = { altitude: 10, speed: raw.s10, direction: raw.d10 };
  const p80 = { altitude: 80, speed: raw.s80, direction: raw.d80 };
  const p120 = (typeof raw.s120 === "number" && typeof raw.d120 === "number")
    ? { altitude: 120, speed: raw.s120, direction: raw.d120 }
    : extrapolate(p10, p80, 120);

  const levels = [
    { altitude: 0, speed: p10.speed, direction: p10.direction },
    interpolate(p10, p80, 30),
    interpolate(p10, p80, 60),
    interpolate(p80, p120, 90),
    { altitude: 120, speed: p120.speed, direction: p120.direction }
  ];

  // Rajadas: Open-Meteo/GFS fornece rajada em 10 m. Para os níveis acima,
  // calculamos uma estimativa conservadora usando a razão rajada/vento em 10 m
  // somada a uma parcela do cisalhamento vertical entre 10 m e o nível.
  let gustRatio = 1.25;
  if(typeof raw.gust10 === "number" && typeof raw.s10 === "number" && raw.s10 > 0){
    gustRatio = Math.max(1, Math.min(2.2, raw.gust10 / raw.s10));
  }

  levels.forEach(level => {
    const shearBoost = Math.max(0, level.speed - p10.speed) * 0.35;
    level.gust = Math.max(level.speed, level.speed * gustRatio + shearBoost);
  });

  return levels;
}

function latestGfsCycleDate(now = new Date()){
  // Fallback local: GFS roda 00/06/12/18 UTC. Usamos uma margem de 6h para
  // evitar indicar um ciclo que ainda pode não estar disponível em todos os servidores.
  const available = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const h = available.getUTCHours();
  const cycleHour = Math.floor(h / 6) * 6;
  return new Date(Date.UTC(
    available.getUTCFullYear(),
    available.getUTCMonth(),
    available.getUTCDate(),
    cycleHour,
    0,
    0
  ));
}

function formatGfsUpdate(date){
  if(!(date instanceof Date) || Number.isNaN(date.getTime())) return "--";
  const localDate = date.toLocaleDateString([], {
    day:"2-digit",
    month:"2-digit",
    year:"numeric"
  });
  const z = String(date.getUTCHours()).padStart(2,"0") + "Z";
  return `${localDate} ${z}`;
}

function parseUnixOrIsoTime(value){
  if(typeof value === "number") return new Date(value * 1000);
  if(typeof value === "string"){
    const asNumber = Number(value);
    if(Number.isFinite(asNumber)) return new Date(asNumber * 1000);
    return new Date(value);
  }
  return null;
}

function findModelUpdateObject(json){
  if(!json) return null;

  if(Array.isArray(json)){
    return json.find(item => item && (
      item.last_run_initialisation_time ||
      item.last_run_initialization_time ||
      item.last_run_availability_time
    )) || null;
  }

  if(json.last_run_initialisation_time || json.last_run_initialization_time || json.last_run_availability_time){
    return json;
  }

  const preferredKeys = ["gfs_seamless", "gfs_global", "gfs", "GFS", "noaa_gfs"];
  for(const key of preferredKeys){
    if(json[key]) return findModelUpdateObject(json[key]);
  }

  for(const value of Object.values(json)){
    const found = findModelUpdateObject(value);
    if(found) return found;
  }

  return null;
}

async function fetchActualGfsUpdate(){
  for(const url of OPEN_METEO_MODEL_UPDATE_URLS){
    try{
      const response = await fetch(url, { cache:"no-store" });
      if(!response.ok) continue;
      const json = await response.json();
      const obj = findModelUpdateObject(json);
      if(!obj) continue;

      const refTime = parseUnixOrIsoTime(
        obj.last_run_initialisation_time ??
        obj.last_run_initialization_time ??
        obj.last_run_reference_time ??
        obj.last_run_time
      );

      const availabilityTime = parseUnixOrIsoTime(obj.last_run_availability_time);

      return {
        run: refTime && !Number.isNaN(refTime.getTime()) ? refTime : null,
        available: availabilityTime && !Number.isNaN(availabilityTime.getTime()) ? availabilityTime : null,
        source: "metadata"
      };
    }catch(_){
      // segue para o próximo formato possível da API de metadata
    }
  }

  return {
    run: latestGfsCycleDate(),
    available: null,
    source: "estimated"
  };
}

function nearestHourIndex(times, utcOffsetSeconds = 0){
  const now = Date.now();
  let idx = 0;
  let best = Infinity;

  times.forEach((timeString, i) => {
    const utcDate = parseOpenMeteoLocalTimeToUtc(timeString, utcOffsetSeconds);
    const diff = utcDate ? Math.abs(utcDate.getTime() - now) : Infinity;
    if(diff < best){
      best = diff;
      idx = i;
    }
  });

  return idx;
}

function numberAt(array, index){
  if(!Array.isArray(array)) return undefined;
  const value = array[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericValue(value){
  if(typeof value === "number" && Number.isFinite(value)) return value;
  if(typeof value === "string"){
    const n = Number(value.trim());
    if(Number.isFinite(n)) return n;
  }
  return undefined;
}

function extractSwpcKp(item){
  if(!item || typeof item !== "object") return undefined;

  // SWPC planetary_k_index_1m.json normally exposes kp_index. Keep a few
  // fallback names so the app keeps working if the JSON key changes slightly.
  const keys = ["kp_index", "Kp", "kp", "k_index", "k", "estimated_kp"];
  for(const key of keys){
    if(Object.prototype.hasOwnProperty.call(item, key)){
      const n = numericValue(item[key]);
      if(typeof n === "number" && Number.isFinite(n)) return n;
    }
  }

  return undefined;
}

function swpcTimeValue(item){
  if(!item || typeof item !== "object") return 0;
  const keys = ["time_tag", "time", "date", "timestamp", "valid_time", "observed_time"];
  for(const key of keys){
    if(item[key] !== undefined){
      const d = new Date(item[key]);
      if(!Number.isNaN(d.getTime())) return d.getTime();
    }
  }
  return 0;
}

async function fetchSwpcKpJson(){
  const urls = [SWPC_KP_URL, SWPC_KP_FALLBACK_PROXY];
  for(const url of urls){
    try{
      const response = await fetch(url, { cache:"no-store" });
      if(!response.ok) continue;
      return await response.json();
    }catch(_){ }
  }
  return null;
}

async function fetchLatestSwpcKp(){
  const json = await fetchSwpcKpJson();
  const rows = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
  if(!rows.length) return null;

  const sorted = [...rows].sort((a,b) => swpcTimeValue(a) - swpcTimeValue(b));

  // Use the latest valid kp_index in the file. If the last row is invalid, walk
  // backwards until a usable non-negative value is found.
  for(let i = sorted.length - 1; i >= 0; i--){
    const kp = extractSwpcKp(sorted[i]);
    if(typeof kp === "number" && Number.isFinite(kp) && kp >= 0){
      return kp;
    }
  }

  return null;
}

function isValidKp(kp){
  return typeof kp === "number" && Number.isFinite(kp) && kp >= 0;
}

async function fetchGfzKpForecastJson(){
  const cacheBust = String(Date.now());
  const sourceUrl = `${GFZ_KP_FORECAST_URL}?_=${cacheBust}`;
  const urls = [
    // Single-proxy build: CorsProxy only.
    "https://corsproxy.io/?" + encodeURIComponent(sourceUrl)
  ];

  for(const url of urls){
    try{
      const response = await fetch(url, { cache:"no-store", headers:{ "Cache-Control":"no-cache" } });
      if(!response.ok) continue;
      const text = await response.text();
      return JSON.parse(text);
    }catch(_){ }
  }
  return null;
}

function parseGfzUtcTime(value){
  if(value === null || value === undefined) return null;
  const text = String(value).trim();
  if(!text) return null;

  let m = text.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const [, dd, mm, yyyy, hh, min, ss] = m;
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), ss ? Number(ss) : 0));
  }

  m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const [, yyyy, mm, dd, hh, min, ss] = m;
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), ss ? Number(ss) : 0));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function valueFromIndexedCollection(collection, key, index){
  if(!collection) return undefined;
  if(Array.isArray(collection)) return collection[index];
  if(Object.prototype.hasOwnProperty.call(collection, key)) return collection[key];
  if(Object.prototype.hasOwnProperty.call(collection, String(index))) return collection[String(index)];
  return undefined;
}

function buildGfzForecastRows(json){
  if(!json || typeof json !== "object") return [];
  const times = json["Time (UTC)"] || json.Time || json.time || json.datetime;
  const median = json.median || json.Median || json.kp_median || json.Kp_median;
  if(!times || !median) return [];

  const rawKeys = Array.isArray(times) ? times.map((_, i) => String(i)) : Object.keys(times);
  const keys = rawKeys.sort((a,b) => Number(a) - Number(b));

  return keys
    .map((key, fallbackIndex) => {
      const numericIndex = Number(key);
      const index = Number.isFinite(numericIndex) ? numericIndex : fallbackIndex;
      const date = parseGfzUtcTime(valueFromIndexedCollection(times, key, index));
      const kp = numericValue(valueFromIndexedCollection(median, key, index));
      return { key, index, date, timeMs: date ? date.getTime() : NaN, kp };
    })
    .filter(row => row.date instanceof Date && !Number.isNaN(row.timeMs))
    .sort((a,b) => a.timeMs - b.timeMs || a.index - b.index);
}

function gfzKpForTime(rows, targetTime){
  if(!Array.isArray(rows) || rows.length === 0) return null;
  const targetMs = targetTime instanceof Date ? targetTime.getTime() : new Date(targetTime).getTime();
  if(Number.isNaN(targetMs)) return null;

  let selectedRowPosition = -1;
  for(let i = 0; i < rows.length; i++){
    if(rows[i].timeMs <= targetMs) selectedRowPosition = i;
    else break;
  }

  if(selectedRowPosition < 0) selectedRowPosition = 0;

  for(let i = selectedRowPosition; i >= 0; i--){
    if(isValidKp(rows[i].kp)) return rows[i].kp;
  }

  for(const row of rows){
    if(isValidKp(row.kp)) return row.kp;
  }

  return null;
}

async function getGfzKpRowsCached(force = false){
  const nowMs = Date.now();
  if(!force && Array.isArray(gfzKpRowsCache) && (nowMs - gfzKpRowsCacheTime) < KP_CACHE_MS){
    return gfzKpRowsCache;
  }

  const gfzJson = await fetchGfzKpForecastJson();
  const rows = buildGfzForecastRows(gfzJson);
  if(Array.isArray(rows) && rows.length > 0){
    gfzKpRowsCache = rows;
    gfzKpRowsCacheTime = nowMs;
  }
  return gfzKpRowsCache || [];
}

async function getLatestSwpcKpCached(force = false){
  const nowMs = Date.now();
  if(!force && isValidKp(latestSwpcKpCache) && (nowMs - latestSwpcKpCacheTime) < KP_CACHE_MS){
    return latestSwpcKpCache;
  }

  const kp = await fetchLatestSwpcKp();
  if(isValidKp(kp)){
    latestSwpcKpCache = kp;
    latestSwpcKpCacheTime = nowMs;
  }
  return latestSwpcKpCache;
}

function parseOpenMeteoLocalTimeToUtc(timeString, utcOffsetSeconds = 0){
  if(!timeString || typeof timeString !== "string") return null;

  const m = timeString.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!m){
    const fallback = new Date(timeString);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, yyyy, mm, dd, hh, min, ss] = m;
  const localAsUtcMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), ss ? Number(ss) : 0);
  return new Date(localAsUtcMs - Number(utcOffsetSeconds || 0) * 1000);
}

function forecastUtcDate(forecast){
  if(!forecast) return null;
  if(forecast.utcTime) return new Date(forecast.utcTime);
  if(Number.isFinite(forecast.utcTimestamp)) return new Date(forecast.utcTimestamp);
  if(forecast.time) return parseOpenMeteoLocalTimeToUtc(forecast.time, forecast.utcOffsetSeconds || 0);
  return null;
}

function utcKpCycleStart(date = new Date()){
  const h = Math.floor(date.getUTCHours() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, 0, 0));
}

function isCurrentUtcKpCycle(targetDate, now = new Date()){
  if(!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return false;
  return utcKpCycleStart(targetDate).getTime() === utcKpCycleStart(now).getTime();
}

function attachKpToForecasts(forecasts, latestKp){
  if(!Array.isArray(forecasts)) return forecasts;
  if(isValidKp(latestKp)){
    latestSwpcKpCache = latestKp;
    latestSwpcKpCacheTime = Date.now();
  }

  forecasts.forEach(forecast => {
    forecast.extra = forecast.extra || {};
    forecast.extra.kpIndex = isValidKp(latestKp) ? Math.round(latestKp) : 0;
    forecast.extra.kpSource = isValidKp(latestKp) ? "SWPC current" : "unavailable";
  });
  return forecasts;
}

async function updateForecastKpFromGfz(forecast, options = {}){
  if(!forecast) return null;
  const selectedUtcDate = forecastUtcDate(forecast);
  if(!selectedUtcDate) return null;

  const force = options.force === true;
  let kp = null;
  let source = "";

  if(isCurrentUtcKpCycle(selectedUtcDate, new Date())){
    const latestKp = await getLatestSwpcKpCached(force);
    if(isValidKp(latestKp)){
      kp = latestKp;
      source = "SWPC current";
    }
  }

  if(!isValidKp(kp)){
    const rows = await getGfzKpRowsCached(force);
    kp = gfzKpForTime(rows, selectedUtcDate);
    source = "GFZ forecast median";
  }

  if(!isValidKp(kp)) return null;

  const rounded = Math.round(kp);
  forecast.extra = forecast.extra || {};
  forecast.extra.kpIndex = rounded;
  forecast.extra.kpSource = source;
  return { kp: rounded, source, utcTime: selectedUtcDate.toISOString() };
}

function formatForecastHour(timeString){
  const d = new Date(timeString);
  if(Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function buildHourlyForecasts(data){
  const times = data.hourly.time;
  const utcOffsetSeconds = Number(data.utc_offset_seconds || 0);
  return times.map((time, idx) => {
    const utcDate = parseOpenMeteoLocalTimeToUtc(time, utcOffsetSeconds);
    return {
      time,
      utcTime: utcDate ? utcDate.toISOString() : null,
      utcTimestamp: utcDate ? utcDate.getTime() : null,
      utcOffsetSeconds,
      label: formatForecastHour(time),
      levels: buildTargetLevels({
        s10: numberAt(data.hourly.wind_speed_10m, idx),
        d10: numberAt(data.hourly.wind_direction_10m, idx),
        s80: numberAt(data.hourly.wind_speed_80m, idx),
        d80: numberAt(data.hourly.wind_direction_80m, idx),
        s120: numberAt(data.hourly.wind_speed_120m, idx),
        d120: numberAt(data.hourly.wind_direction_120m, idx),
        gust10: numberAt(data.hourly.wind_gusts_10m, idx)
      }),
      extra: {
        temperature: numberAt(data.hourly.temperature_2m, idx),
        precipitation: numberAt(data.hourly.precipitation, idx),
        precipitationProbability: numberAt(data.hourly.precipitation_probability, idx),
        visibility: numberAt(data.hourly.visibility, idx),
        kIndex: numberAt(data.hourly.k_index, idx)
      }
    };
  });
}

function buildDailySolar(data){
  if(!data.daily || !Array.isArray(data.daily.time)) return [];
  return data.daily.time.map((date, idx) => ({
    date,
    sunrise: Array.isArray(data.daily.sunrise) ? data.daily.sunrise[idx] : undefined,
    sunset: Array.isArray(data.daily.sunset) ? data.daily.sunset[idx] : undefined
  }));
}

function maxNumber(array){
  if(!Array.isArray(array)) return undefined;
  const vals = array.filter(v => typeof v === "number" && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : undefined;
}

function hasUsableVisibilitySeries(data){
  return !!(data && data.hourly && Array.isArray(data.hourly.visibility) && data.hourly.visibility.some(v => typeof v === "number" && Number.isFinite(v)));
}

async function fetchHourlyVisibilitySeries(lat, lon){
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "auto",
    forecast_hours: "24",
    hourly: "visibility"
  });

  const response = await fetch(`${OPEN_METEO_VISIBILITY_ENDPOINT}?${params.toString()}`, { cache:"no-store" });
  if(!response.ok) return null;

  const json = await response.json();
  if(!json || !json.hourly || !Array.isArray(json.hourly.time) || !Array.isArray(json.hourly.visibility)){
    return null;
  }

  return json.hourly;
}

function mergeVisibilityIntoWeatherData(data, visibilityHourly){
  if(!data || !data.hourly || !Array.isArray(data.hourly.time) || !visibilityHourly) return data;
  if(!Array.isArray(visibilityHourly.time) || !Array.isArray(visibilityHourly.visibility)) return data;

  const byTime = new Map();
  visibilityHourly.time.forEach((time, idx) => {
    const value = visibilityHourly.visibility[idx];
    if(typeof value === "number" && Number.isFinite(value)){
      byTime.set(time, value);
    }
  });

  const merged = data.hourly.time.map((time, idx) => {
    const value = byTime.get(time);
    if(typeof value === "number" && Number.isFinite(value)) return value;

    // Fallback for any rare time-label mismatch: keep the same index when valid.
    const indexValue = visibilityHourly.visibility[idx];
    if(typeof indexValue === "number" && Number.isFinite(indexValue)) return indexValue;

    // Last fallback: preserve whatever came in the original GFS response.
    return Array.isArray(data.hourly.visibility) ? data.hourly.visibility[idx] : undefined;
  });

  data.hourly.visibility = merged;
  return data;
}

async function refreshVisibilitySeries(lat, lon, data){
  try{
    const visibilityHourly = await fetchHourlyVisibilitySeries(lat, lon);
    if(visibilityHourly) mergeVisibilityIntoWeatherData(data, visibilityHourly);
  }catch(_){
    // If the separate visibility request fails, keep the existing GFS visibility.
  }
  return data;
}

async function fetchOpenMeteo(lat, lon){
  const baseParams = {
    latitude: lat,
    longitude: lon,
    wind_speed_unit: "ms",
    timezone: "auto",
    forecast_hours: "24",
    daily: "sunrise,sunset"
  };

  async function request(hourly){
    const params = new URLSearchParams({ ...baseParams, hourly });
    const url = `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
    const response = await fetch(url, { cache: "no-store" });

    if(!response.ok){
      let message = "Falha na API Open-Meteo GFS";
      try{
        const errorData = await response.json();
        if(errorData && errorData.reason) message += `: ${errorData.reason}`;
      }catch(_){ }
      throw new Error(message);
    }

    return await response.json();
  }

  const windVars = "wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m,wind_gusts_10m";
  let data;

  try{
    data = await request(`${windVars},temperature_2m,visibility,precipitation_probability,k_index`);
  }catch(_firstError){
    try{
      data = await request(`${windVars},temperature_2m,visibility,precipitation_probability`);
    }catch(_secondError){
      try{
        data = await request(`${windVars},temperature_2m,visibility`);
      }catch(_thirdError){
        try{
          data = await request("wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_gusts_10m,temperature_2m,visibility,precipitation_probability");
        }catch(_fourthError){
          data = await request("wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m");
        }
      }
    }
  }

  if(!data.hourly || !Array.isArray(data.hourly.time) || data.hourly.time.length === 0){
    throw new Error("Resposta inválida da Open-Meteo.");
  }

  // Always refresh the hourly visibility series separately and merge it by hour.
  // This fixes cases where visibility looked unchanged while other fields updated.
  await refreshVisibilitySeries(lat, lon, data);

  const updateInfo = await fetchActualGfsUpdate();
  const updateText = updateInfo.run
    ? formatGfsUpdate(updateInfo.run)
    : formatGfsUpdate(latestGfsCycleDate());

  const forecasts = buildHourlyForecasts(data);
  const latestKp = await getLatestSwpcKpCached(true);
  attachKpToForecasts(forecasts, latestKp);
  const selectedIndex = nearestHourIndex(data.hourly.time, data.utc_offset_seconds || 0);

  return {
    forecasts,
    levels: forecasts[selectedIndex] ? forecasts[selectedIndex].levels : forecasts[0].levels,
    selectedIndex,
    dailySolar: buildDailySolar(data),
    maxPrecipProbability: maxNumber(data.hourly.precipitation_probability),
    gfsUpdate: updateText,
    gfsUpdateSource: updateInfo.source,
    currentTime: forecasts[selectedIndex] ? forecasts[selectedIndex].time : data.hourly.time[0]
  };
}
