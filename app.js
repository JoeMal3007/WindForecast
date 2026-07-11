let currentLevels = [];
let currentForecasts = [];
let currentDailySolar = [];
let currentMaxPrecipProbability = undefined;
let selectedForecastIndex = 0;
let selectedWind = null;
let deviceHeading = 0;
let continuousHeading = 0;
let lastRawHeading = null;
let compassAvailable = false;
let calibrationHeading = Number(localStorage.getItem("DroneWind:compassCalibrationHeading") || 0);
let displayedCompassHeading = 0;
let displayedWindArrowAngle = null;
let watchTimer = null;
let lastHourHandDeg = 0;
let lastCalibrationLineDeg = 0;
let lastPosition = null;
let currentLocation = null;
let selectedLocation = null;
let pendingMapSelection = null;
let mapInstance = null;
let selectedMarker = null;
let currentMarker = null;
let longPressTimer = null;
let autoRefreshTimer = null;
let kpPreloadTimer = null;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = "DroneWind:lastWeather:v43";

const el = id => document.getElementById(id);

function setText(id, text){
  const node = el(id);
  if(node) node.textContent = text;
}

function setStatus(text){
  setText("status", text);
}

function formatRefreshTime(date = new Date()){
  return date.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

function setActiveTab(tab){
  const forecastActive = tab === "forecast";
  const pageForecast = el("pageForecast");
  const pageCompass = el("pageCompass");
  const tabForecast = el("tabForecast");
  const tabCompass = el("tabCompass");

  if(pageForecast) pageForecast.classList.toggle("active", forecastActive);
  if(pageCompass) pageCompass.classList.toggle("active", !forecastActive);
  if(tabForecast) tabForecast.classList.toggle("active", forecastActive);
  if(tabCompass) tabCompass.classList.toggle("active", !forecastActive);
  document.body.classList.toggle("compass-tab-active", !forecastActive);
  document.body.classList.toggle("forecast-tab-active", forecastActive);

  if(!forecastActive) updateCompass();
}

function setGfsUpdateLine(gfsUpdate, date = new Date()){
  const node = el("gfsUpdate");
  if(!node) return;
  node.textContent = `Última atualiz.: ${formatRefreshTime(date)} - ${gfsUpdate || "--"}`;
}

function startKpForecastPreload(){
  // Preload GFZ Kp forecast in the background so future-hour selection is fast.
  // Uses the single configured proxy inside wind.js (CorsProxy in this build).
  async function preload(){
    try{
      if(typeof getGfzKpRowsCached === "function"){
        await getGfzKpRowsCached(false);
      }
    }catch(_){
      // Silent by design: this must never delay or block the app launch.
    }
  }

  preload();
  if(kpPreloadTimer) clearInterval(kpPreloadTimer);
  kpPreloadTimer = setInterval(preload, 5 * 60 * 1000);
}

window.addEventListener("DOMContentLoaded", () => {
  makeTicks();
  if(el("refreshBtn")) el("refreshBtn").addEventListener("click", refreshWeather);
  el("mapBtn").addEventListener("click", openMap);
  el("topAimBtn").addEventListener("click", useCurrentLocationNow);
  el("calibrateBtn").addEventListener("click", openCalibration);
  if(el("tabForecast")) el("tabForecast").addEventListener("click", () => setActiveTab("forecast"));
  if(el("tabCompass")) el("tabCompass").addEventListener("click", () => setActiveTab("compass"));
  el("closeCalibrationBtn").addEventListener("click", closeCalibration);
  el("closeMapBtn").addEventListener("click", closeMap);
  el("altitudeSelect").addEventListener("change", onAltitudeChange);
  document.addEventListener("click", enableCompassOnce, { once:true });
  document.addEventListener("touchend", enableCompassOnce, { once:true });
  setActiveTab("forecast");
  startCompassListeners();
  loadCachedWeather();
  startKpForecastPreload();
  refreshWeather();
  startAutoRefresh();
});

function polarToXY(center, radius, degrees){
  const rad = (degrees - 90) * Math.PI / 180;
  return {
    x: center + radius * Math.cos(rad),
    y: center + radius * Math.sin(rad)
  };
}

function makeTicks(){
  const ticks = el("svgTicks");
  const labels = el("svgLabels");
  ticks.innerHTML = "";
  labels.innerHTML = "";

  const center = 180;
  const outer = 158;

  for(let deg=0; deg<360; deg++){
    const isTen = deg % 10 === 0;
    const isFive = deg % 5 === 0;
    const inner = isTen ? 137 : isFive ? 146 : 151;
    const p1 = polarToXY(center, inner, deg);
    const p2 = polarToXY(center, outer, deg);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", p1.x.toFixed(2));
    line.setAttribute("y1", p1.y.toFixed(2));
    line.setAttribute("x2", p2.x.toFixed(2));
    line.setAttribute("y2", p2.y.toFixed(2));
    line.setAttribute("class", "tick-line" + (isTen ? " ten" : isFive ? " five" : ""));
    ticks.appendChild(line);
  }

  const cardinals = [[0, "N"], [90, "E"], [180, "S"], [270, "W"]];
  cardinals.forEach(([deg, txt])=>{
    const p = polarToXY(center, 118, deg);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", p.x.toFixed(2));
    t.setAttribute("y", p.y.toFixed(2));
    t.setAttribute("class", "cardinal-label");
    t.textContent = txt;
    labels.appendChild(t);
  });

  for(let deg=0; deg<360; deg+=30){
    const p = polarToXY(center, 94, deg);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", p.x.toFixed(2));
    t.setAttribute("y", p.y.toFixed(2));
    t.setAttribute("class", "degree-label");
    t.textContent = String(deg);
    labels.appendChild(t);
  }
}

async function enableCompassOnce(){
  try{
    if(typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
      await DeviceOrientationEvent.requestPermission();
    }
    startCompassListeners();
  }catch(e){
    console.warn("Não foi possível ativar a orientação do iPhone neste navegador.");
  }
}

function startCompassListeners(){
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
}

function onOrientation(event){
  let heading = null;
  if(typeof event.webkitCompassHeading === "number") heading = event.webkitCompassHeading;
  else if(event.absolute === true && typeof event.alpha === "number") heading = (360 - event.alpha) % 360;
  else if(typeof event.alpha === "number") heading = (360 - event.alpha) % 360;
  if(heading === null || Number.isNaN(heading)) return;
  compassAvailable = true;

  if(lastRawHeading === null){
    lastRawHeading = heading;
    continuousHeading = heading;
  }else{
    const delta = ((heading - lastRawHeading + 540) % 360) - 180;
    continuousHeading += delta;
    lastRawHeading = heading;
  }

  deviceHeading = heading;
  updateCompass();
}

async function refreshWeather(options = {}){
  const useLastPosition = options.useLastPosition === true;

  if(useLastPosition && selectedLocation){
    setStatus("Atualizando automaticamente...");
    await refreshWeatherForPosition(selectedLocation.lat, selectedLocation.lon, { source:"selected" });
    return;
  }

  setStatus(selectedLocation ? "Atualizando local selecionado..." : "Obtendo localização...");

  if(selectedLocation){
    await refreshWeatherForPosition(selectedLocation.lat, selectedLocation.lon, { source:"selected" });
    return;
  }

  if(!navigator.geolocation){
    setStatus("GPS não suportado.");
    loadCachedWeather(true);
    return;
  }

  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    currentLocation = { lat, lon };
    selectedLocation = { lat, lon };
    pendingMapSelection = { lat, lon };
    updateCrosshairState();
    await refreshWeatherForPosition(lat, lon, { source:"current" });
  }, err => {
    setStatus("Erro no GPS: " + err.message);
    loadCachedWeather(true);
  }, { enableHighAccuracy:true, timeout:12000, maximumAge:60000 });
}

async function refreshWeatherForPosition(lat, lon, options = {}){
  lastPosition = { lat, lon };
  selectedLocation = { lat, lon };
  updatePlaceLabel(lat, lon, options.source || "selected");
  updateMapMarkers();

  try{
    setStatus("Buscando vento GFS...");
    const weather = await fetchOpenMeteo(lat, lon);
    applyWeather(weather, weather.selectedIndex ?? 0);
    setGfsUpdateLine(weather.gfsUpdate, new Date());
    setStatus("Dados atualizados");
    
    saveCachedWeather(lat, lon, weather);
  }catch(e){
    setStatus(e.message);
    loadCachedWeather(true);
  }
}

function updatePlaceLabel(lat, lon, source = "selected"){
  // Always display only "Local", without "atual" or "selecionado".
  el("place").textContent = `Local: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  updateCrosshairState();
}

function sameLocation(a, b){
  if(!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lon - b.lon) < 0.00001;
}

function updateCrosshairState(){
  const btn = el("topAimBtn");
  if(!btn) return;
  const isCurrent = sameLocation(selectedLocation, currentLocation);
  btn.classList.toggle("current-selected", !!isCurrent);
}

function applyWeather(weather, preferredIndex = 0){
  currentDailySolar = Array.isArray(weather.dailySolar) ? weather.dailySolar : [];
  currentMaxPrecipProbability = weather.maxPrecipProbability;

  if(Array.isArray(weather.forecasts) && weather.forecasts.length > 0){
    currentForecasts = weather.forecasts;
    selectedForecastIndex = Math.max(0, Math.min(currentForecasts.length - 1, preferredIndex));
    currentLevels = currentForecasts[selectedForecastIndex].levels;
  }else if(Array.isArray(weather.levels)){
    currentForecasts = [{ time: weather.currentTime || new Date().toISOString(), label: "Agora", levels: weather.levels, extra: weather.extra || {} }];
    selectedForecastIndex = 0;
    currentLevels = weather.levels;
  }else{
    currentForecasts = [];
    currentLevels = [];
    selectedForecastIndex = 0;
  }

  selectedWind = levelFromSelector() || currentLevels[0] || null;
  renderForecastTable();
  renderAdditionalInfo();
  renderBars();
  updateCompass();
}

function saveCachedWeather(lat, lon, weather){
  try{
    const payload = { savedAt: new Date().toISOString(), lat, lon, weather };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  }catch(_){ }
}

function loadCachedWeather(showStatus = false){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if(!raw) return false;
    const cached = JSON.parse(raw);
    if(!cached || !cached.weather) return false;

    lastPosition = { lat: cached.lat, lon: cached.lon };
    if(showStatus){
      selectedLocation = { lat: cached.lat, lon: cached.lon };
      pendingMapSelection = { lat: cached.lat, lon: cached.lon };
    }
    applyWeather(cached.weather, cached.weather.selectedIndex ?? 0);

    if(Number.isFinite(cached.lat) && Number.isFinite(cached.lon)){
      updatePlaceLabel(cached.lat, cached.lon, showStatus ? "selected" : "cache");
    }
    setGfsUpdateLine(cached.weather.gfsUpdate || "--", cached.savedAt ? new Date(cached.savedAt) : new Date());

    if(showStatus) setStatus("Sem dados novos; exibindo último cache");
    return true;
  }catch(_){
    return false;
  }
}

function startAutoRefresh(){
  if(autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if(document.hidden) return;
    refreshWeather({ useLastPosition:true });
  }, AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if(!document.hidden && selectedLocation) refreshWeather({ useLastPosition:true });
  });
}

function onAltitudeChange(){
  const w = levelFromSelector();
  if(!w) return;
  selectedWind = w;
  renderForecastTable();
  updateCompass();
}

function selectForecastColumn(index){
  if(!Array.isArray(currentForecasts) || !currentForecasts[index]) return;
  selectedForecastIndex = index;
  currentLevels = currentForecasts[index].levels;
  selectedWind = levelFromSelector() || currentLevels[0] || null;
  renderForecastTable();
  renderAdditionalInfo();
  renderBars();
  updateCompass();
  triggerSelectedHourKpForecast(index);
}

async function triggerSelectedHourKpForecast(index){
  // Independent Kp forecast routine: only runs when a non-zero hour column is selected.
  // Index 0 is ignored, as requested.
  if(index === 0) return;
  const forecast = currentForecasts[index];
  if(!forecast || typeof updateForecastKpFromGfz !== "function") return;

  const previous = forecast.extra && forecast.extra.kpIndex;
  setInfoValue("infoKpIndex", "...");

  try{
    const result = await updateForecastKpFromGfz(forecast, { force:false });
    if(selectedForecastIndex !== index) return;
    if(result && typeof result.kp === "number" && Number.isFinite(result.kp)){
      setInfoValue("infoKpIndex", formatKp(result.kp));
      renderFlightRecommendation();
      saveCachedWeather(selectedLocation?.lat ?? lastPosition?.lat, selectedLocation?.lon ?? lastPosition?.lon, {
        forecasts: currentForecasts,
        selectedIndex: selectedForecastIndex,
        dailySolar: currentDailySolar,
        maxPrecipProbability: currentMaxPrecipProbability,
        gfsUpdate: (el("gfsUpdate")?.textContent || "").replace(/^Última atualiz\.:\s*/, "")
      });
    }else{
      setInfoValue("infoKpIndex", formatKp(previous));
    }
  }catch(_){
    if(selectedForecastIndex === index) setInfoValue("infoKpIndex", formatKp(previous));
  }
}

function levelFromSelector(){
  const target = Number(el("altitudeSelect").value);
  return currentLevels.find(w => Math.round(w.altitude) === target) || null;
}

function altitudeLabel(w){
  return w.altitude === 0 ? "SFC" : `${Math.round(w.altitude)} m`;
}

function windRgbForKt(kt){
  // Criticality scale: 0 kt = green, 6.5 kt = yellow, 13+ kt = red.
  const max = 13;
  const t = Math.max(0, Math.min(1, kt / max));

  const green = { r: 39,  g: 216, b: 90  }; // #27d85a
  const yellow = { r: 255, g: 216, b: 74  }; // #ffd84a
  const red = { r: 255, g: 69,  b: 58  }; // #ff453a

  const a = t <= 0.5 ? green : yellow;
  const b = t <= 0.5 ? yellow : red;
  const k = t <= 0.5 ? t / 0.5 : (t - 0.5) / 0.5;

  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k)
  };
}

function windColorForKt(kt){
  const c = windRgbForKt(kt);
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function windCellBackgroundForKt(kt){
  const c = windRgbForKt(kt);
  // Use a real RGBA color instead of color-mix(), because Safari/iOS can render
  // color-mix inconsistently. 13 kt and above will always be red.
  return `rgba(${c.r}, ${c.g}, ${c.b}, 0.82)`;
}

function lightenColorForKt(kt){
  const max = 13;
  const t = Math.max(0, Math.min(1, kt / max));
  if(t <= 0.5) return 'rgb(170, 255, 178)';
  return 'rgb(255, 182, 120)';
}

function windBlowingDirection(directionFromDeg){
  return (directionFromDeg + 180) % 360;
}

function windArrowHtml(directionFromDeg, extraClass = ""){
  const blowTo = windBlowingDirection(directionFromDeg);
  return `<span class="wind-cell-arrow${extraClass}" style="transform:rotate(${blowTo}deg);" title="Soprando para ${Math.round(blowTo)}°">↑</span>`;
}

function renderForecastTable(){
  const head = el("forecastHead");
  const body = el("forecastBody");
  if(!head || !body) return;

  head.innerHTML = `<th class="alt-head">Alt / kt</th>`;
  currentForecasts.forEach((forecast, i) => {
    const th = document.createElement("th");
    th.className = `time-head${i === selectedForecastIndex ? " selected-col" : ""}`;
    th.textContent = forecast.label || formatForecastHour(forecast.time);
    th.addEventListener("click", () => selectForecastColumn(i));
    head.appendChild(th);
  });

  body.innerHTML = "";
  const altitudeOrder = [120, 90, 60, 30, 0];
  altitudeOrder.forEach(alt => {
    const tr = document.createElement("tr");
    const isSelectedAltitude = selectedWind && Math.round(selectedWind.altitude) === alt;
    tr.className = isSelectedAltitude ? "selected-alt-row" : "";

    const label = alt === 0 ? "SFC" : `${alt} m`;
    const th = document.createElement("th");
    th.className = "alt-cell";
    th.textContent = label;
    th.addEventListener("click", () => {
      el("altitudeSelect").value = String(alt);
      onAltitudeChange();
    });
    tr.appendChild(th);

    currentForecasts.forEach((forecast, i) => {
      const w = forecast.levels.find(level => Math.round(level.altitude) === alt);
      const td = document.createElement("td");
      td.className = `wind-hour-cell${i === selectedForecastIndex ? " selected-col" : ""}`;
      if(w){
        const kt = Math.round(toKt(w.speed));
        const windParamLevel = alt === 0 ? parameterLevel("wind", sfcMaxWindKtFromLevels(forecast.levels)) : "neutral";
        const windParamClass = alt === 0 ? ` param-${windParamLevel}` : "";
        td.style.background = windCellBackgroundForKt(kt);
        td.style.color = "#eef4ff";
        td.style.webkitTextFillColor = "#eef4ff";
        td.innerHTML = `<span class="wind-cell-value${windParamClass}">${kt}</span>${windArrowHtml(w.direction, windParamClass)}`;
        td.title = `${label}, ${forecast.label}: ${kt} kt, soprando para ${Math.round(windBlowingDirection(w.direction))}°`;
      }else{
        td.textContent = "--";
      }
      td.addEventListener("click", () => {
        if(w){
          el("altitudeSelect").value = String(alt);
          selectForecastColumn(i);
        }else{
          selectForecastColumn(i);
        }
      });
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });

  const selected = head.querySelector(".selected-col");
  if(selected && typeof selected.scrollIntoView === "function"){
    selected.scrollIntoView({ inline:"center", block:"nearest", behavior:"smooth" });
  }
}


function formatMaybeNumber(value, digits = 0){
  return (typeof value === "number" && Number.isFinite(value)) ? value.toFixed(digits) : "--";
}

function formatKp(value){
  return (typeof value === "number" && Number.isFinite(value)) ? String(Math.round(value)) : "--";
}

function formatPercent(value){
  return (typeof value === "number" && Number.isFinite(value)) ? `${Math.round(value)}%` : "--";
}

function formatMm(value){
  return (typeof value === "number" && Number.isFinite(value)) ? `${value.toFixed(1)} mm` : "--";
}

function formatVisibility(value){
  if(typeof value !== "number" || !Number.isFinite(value)) return "--";
  if(value >= 10000) return `${(value / 1000).toFixed(0)} km`;
  if(value >= 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value)} m`;
}

function formatClock(value){
  if(!value) return "--";
  const d = new Date(value);
  if(Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function selectedSolar(){
  const forecast = currentForecasts[selectedForecastIndex];
  if(!forecast || !forecast.time) return null;
  const dateKey = forecast.time.slice(0, 10);
  return currentDailySolar.find(d => d.date === dateKey) || currentDailySolar[0] || null;
}

function setInfoValue(id, value){
  const node = el(id);
  if(node) node.textContent = value;
}

function setParamColor(id, level){
  const node = el(id);
  if(!node) return;
  node.classList.remove("param-good", "param-caution", "param-no-fly", "param-neutral");
  node.classList.add(`param-${level || "neutral"}`);
}

function parameterLevel(kind, value, secondaryValue){
  if(kind === "wind"){
    if(typeof value !== "number" || !Number.isFinite(value)) return "neutral";
    if(value >= 9) return "no-fly";
    if(value > 5) return "caution";
    return "good";
  }
  if(kind === "temp"){
    if(typeof value !== "number" || !Number.isFinite(value)) return "neutral";
    return (value >= 0 && value <= 40) ? "good" : "no-fly";
  }
  if(kind === "kp"){
    if(typeof value !== "number" || !Number.isFinite(value)) return "neutral";
    return value <= 4 ? "good" : "no-fly";
  }
  if(kind === "visibility"){
    if(typeof value !== "number" || !Number.isFinite(value)) return "neutral";
    if(value < 500) return "no-fly";
    if(value <= 1000) return "caution";
    return "good";
  }
  if(kind === "precip"){
    const current = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const max = typeof secondaryValue === "number" && Number.isFinite(secondaryValue) ? secondaryValue : current;
    if(typeof current !== "number" && typeof max !== "number") return "neutral";
    if((typeof current === "number" && current >= 35) || (typeof max === "number" && max >= 35)) return "no-fly";
    return "good";
  }
  return "neutral";
}

function sfcMaxWindKtFromLevels(levels){
  const sfc = Array.isArray(levels) ? (levels.find(w => Math.round(w.altitude) === 0) || levels[0]) : null;
  if(!sfc) return undefined;
  const windKt = toKt(sfc.speed);
  const gustKt = toKt(sfc.gust || sfc.speed);
  return Math.max(
    typeof windKt === "number" && Number.isFinite(windKt) ? windKt : -Infinity,
    typeof gustKt === "number" && Number.isFinite(gustKt) ? gustKt : -Infinity
  );
}

function renderAdditionalInfo(){
  const forecast = currentForecasts[selectedForecastIndex];
  const extra = forecast && forecast.extra ? forecast.extra : {};
  const solar = selectedSolar();

  // Use the precipitation probability from the selected hour.
  // Previously this used currentMaxPrecipProbability, which is the maximum over
  // the whole 24h request and therefore did not change when another hour was
  // selected.
  const currentPrecip = extra.precipitationProbability;
  const maxPrecip = currentPrecip;

  setInfoValue("infoTemp", `${formatMaybeNumber(extra.temperature, 1)} °C`);
  setInfoValue("infoVisibility", formatVisibility(extra.visibility));
  setInfoValue("infoProb", formatPercent(maxPrecip));
  setInfoValue("infoKpIndex", formatKp(extra.kpIndex));
  setInfoValue("infoSunrise", solar ? formatClock(solar.sunrise) : "--");
  setInfoValue("infoSunset", solar ? formatClock(solar.sunset) : "--");

  setParamColor("infoTemp", parameterLevel("temp", extra.temperature));
  setParamColor("infoVisibility", parameterLevel("visibility", extra.visibility));
  setParamColor("infoProb", parameterLevel("precip", currentPrecip, maxPrecip));
  setParamColor("infoKpIndex", parameterLevel("kp", extra.kpIndex));

  renderFlightRecommendation();
}

function renderFlightRecommendation(){
  const node = el("flightRecommendation");
  if(!node) return;

  const forecast = currentForecasts[selectedForecastIndex];
  const extra = forecast && forecast.extra ? forecast.extra : {};
  const maxWindKt = sfcMaxWindKtFromLevels(currentLevels);
  const temp = extra.temperature;
  const kp = extra.kpIndex;
  const visibility = extra.visibility;
  // Recommendation uses the precipitation probability for the selected hour,
  // so moving across the hourly table updates the precipitation factor just as
  // temperature and visibility do.
  const currentPrecip = extra.precipitationProbability;
  const maxPrecip = currentPrecip;

  const windLevel = parameterLevel("wind", maxWindKt);
  const tempLevel = parameterLevel("temp", temp);
  const kpLevel = parameterLevel("kp", kp);
  const visibilityLevel = parameterLevel("visibility", visibility);
  const precipLevel = parameterLevel("precip", currentPrecip, maxPrecip);

  const allKnown = [windLevel, tempLevel, kpLevel, visibilityLevel, precipLevel].every(v => v !== "neutral");

  let level = "neutral";
  let text = "Dados insuficientes";

  if([windLevel, tempLevel, kpLevel, visibilityLevel, precipLevel].includes("no-fly")){
    level = "no-fly";
    text = "Não voe";
  }else if(allKnown && [windLevel, visibilityLevel].includes("caution")){
    level = "caution";
    text = "Voe com cautela";
  }else if(allKnown && windLevel === "good" && tempLevel === "good" && kpLevel === "good" && visibilityLevel === "good" && precipLevel === "good"){
    level = "good";
    text = "Bom para voar";
  }

  node.className = `flight-recommendation ${level}`;
  node.textContent = text;
}

function normalizeDeg(deg){
  return ((deg % 360) + 360) % 360;
}

function effectiveCompassHeading(){
  // Return a continuous, unwrapped angle for CSS transforms.
  // This prevents flicker/jumps at 359° -> 001° and 001° -> 359°.
  return continuousHeading - calibrationHeading;
}

function effectiveCompassHeadingLabel(){
  return normalizeDeg(effectiveCompassHeading());
}

function openCalibration(){
  const overlay = el("calibrationOverlay");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  updateWatch();
  if(watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(updateWatch, 1000);
}

function closeCalibration(){
  const overlay = el("calibrationOverlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  if(watchTimer){
    clearInterval(watchTimer);
    watchTimer = null;
  }

  // The direction the iPhone is pointing now becomes the app's true north.
  calibrationHeading = normalizeDeg(continuousHeading);
  localStorage.setItem("DroneWind:compassCalibrationHeading", String(calibrationHeading));
  updateCompass();
}

function shortestDeltaDeg(from, to){
  return ((to - from + 540) % 360) - 180;
}

function smoothClockAngle(lastAngle, targetAngle){
  return lastAngle + shortestDeltaDeg(lastAngle, targetAngle);
}

function updateWatch(){
  const now = new Date();
  const seconds = now.getSeconds();
  const minutes = now.getMinutes() + seconds / 60;
  const hours = (now.getHours() % 12) + minutes / 60;

  const hourDegRaw = hours * 30;
  const minuteDeg = minutes * 6;

  lastHourHandDeg = smoothClockAngle(lastHourHandDeg, hourDegRaw);

  // Red line halfway between the hour hand and the 12 o’clock position.
  const halfToTwelve = shortestDeltaDeg(hourDegRaw, 0) / 2;
  const redDegRaw = normalizeDeg(hourDegRaw + halfToTwelve);
  lastCalibrationLineDeg = smoothClockAngle(lastCalibrationLineDeg, redDegRaw);

  el("watchHourHand").style.transform = `rotate(${lastHourHandDeg}deg)`;
  el("watchMinuteHand").style.transform = `rotate(${minuteDeg}deg)`;
  el("calibrationRedLine").style.transform = `rotate(${lastCalibrationLineDeg}deg)`;
}

function updateCompass(){
  if(!selectedWind) return;

  // Keep both dial and arrow angles continuous to avoid the Safari/iOS
  // transform transition flicker at the north crossing.
  const heading = effectiveCompassHeading();
  displayedCompassHeading = heading;
  el("compassDial").style.transform = `rotate(${-displayedCompassHeading}deg)`;

  const targetArrow = selectedWind.direction - 90;
  if(displayedWindArrowAngle === null){
    displayedWindArrowAngle = targetArrow;
  }else{
    displayedWindArrowAngle += shortestDeltaDeg(displayedWindArrowAngle, targetArrow);
  }
  // A seta da bússola representa vento vindo de, como na notação meteorológica.
  el("windArrow").style.transform = `rotate(${displayedWindArrowAngle}deg)`;

  const selectedKt = toKt(selectedWind.speed);
  document.documentElement.style.setProperty("--windColor", windColorForKt(selectedKt));
  document.documentElement.style.setProperty("--windColorLight", lightenColorForKt(selectedKt));

  el("headingLabel").textContent = compassAvailable ? `${Math.round(effectiveCompassHeadingLabel())}°` : "--°";
}

function windColor(k){
  const t = Math.min(13, Math.max(0, k)) / 13;
  if(t < 0.5){
    const p = t / 0.5;
    return `rgb(${Math.round(255*p)},200,0)`;
  }
  const p = (t - 0.5) / 0.5;
  return `rgb(255,${Math.round(200*(1-p))},0)`;
}

function renderBars(){
  const bars = el("bars");
  bars.innerHTML = "";
  const maxScaleKt = 13;
  [...currentLevels].reverse().forEach(w=>{
    const kt = toKt(w.speed);
    const gkt = Math.round(toKt(w.gust || w.speed));
    const rawWidth = Math.min(100, Math.max(0, kt / maxScaleKt * 100));
    const width = Math.max(4, rawWidth);
    const backgroundSize = `${10000 / Math.max(width, 1)}% 100%`;
    const r = document.createElement("div");
    r.className = "bar-row";
    r.innerHTML = `<span>${w.altitude===0?"SFC":Math.round(w.altitude)+" m"}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%; background-size:${backgroundSize}"></div></div><span>${Math.round(kt)} / <span class="gust" style="color:${windColor(gkt)}">${gkt}</span> kt</span>`;
    bars.appendChild(r);
  });
}


// v13 map selector ----------------------------------------------------------
function openMap(){
  const overlay = el("mapOverlay");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  const start = pendingMapSelection || selectedLocation || currentLocation || lastPosition || { lat: 0, lon: 0 };
  pendingMapSelection = { lat: start.lat, lon: start.lon };

  setTimeout(() => {
    initMapIfNeeded(start.lat, start.lon);
    if(mapInstance){
      mapInstance.invalidateSize();
      mapInstance.setView([start.lat, start.lon], mapInstance.getZoom() || 12);
      updateMapMarkers();
    }
  }, 80);
}

async function closeMap(){
  const overlay = el("mapOverlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");

  // When the window is closed, immediately use the selected map point.
  if(pendingMapSelection && !sameLocation(pendingMapSelection, selectedLocation)){
    selectedLocation = { ...pendingMapSelection };
    await refreshWeatherForPosition(selectedLocation.lat, selectedLocation.lon, {
      source: sameLocation(selectedLocation, currentLocation) ? "current" : "selected"
    });
  }
}

function initMapIfNeeded(lat, lon){
  if(typeof L === "undefined"){
    el("mapHint").textContent = "Mapa indisponível. Verifique a conexão com a internet.";
    return;
  }
  if(mapInstance) return;

  mapInstance = L.map("map", {
    zoomControl:true,
    attributionControl:true
  }).setView([lat, lon], 13);

  // Google Maps road tiles. This keeps the lightweight Leaflet UI while using
  // Google map imagery/tiles as requested.
  L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
    subdomains:["0","1","2","3"],
    maxZoom: 20,
    attribution: "Map data &copy; Google"
  }).addTo(mapInstance);

  // Single tap/click selects the point immediately.
  mapInstance.on("click", e => {
    if(e && e.latlng) setPendingMapSelection(e.latlng.lat, e.latlng.lng);
  });

  updateMapMarkers();
}

function clearLongPressTimer(){
  if(longPressTimer){
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function currentIcon(){
  return L.divIcon({
    className:"current-location-marker",
    html:'<div class="current-location-dot"></div>',
    iconSize:[26,26],
    iconAnchor:[13,13]
  });
}

function selectedIcon(){
  return L.divIcon({
    className:"selected-location-marker",
    html:'<div class="selected-location-pin"></div>',
    iconSize:[32,32],
    iconAnchor:[16,30]
  });
}

function updateMapMarkers(){
  if(!mapInstance || typeof L === "undefined") return;

  if(currentLocation){
    const p = [currentLocation.lat, currentLocation.lon];
    if(!currentMarker) currentMarker = L.marker(p, { icon: currentIcon(), interactive:false }).addTo(mapInstance);
    else currentMarker.setLatLng(p);
  }

  const selected = pendingMapSelection || selectedLocation;
  if(selected){
    const p = [selected.lat, selected.lon];
    if(!selectedMarker) selectedMarker = L.marker(p, { icon: selectedIcon(), draggable:true }).addTo(mapInstance);
    else selectedMarker.setLatLng(p);

    selectedMarker.off("dragend");
    selectedMarker.on("dragend", () => {
      const pos = selectedMarker.getLatLng();
      setPendingMapSelection(pos.lat, pos.lng, false);
    });
  }
}

function setPendingMapSelection(lat, lon, pan = true){
  pendingMapSelection = { lat, lon };
  el("mapHint").textContent = `Selecionado: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  updateMapMarkers();
  if(pan && mapInstance) mapInstance.panTo([lat, lon]);
}

function useCurrentLocationNow(){
  if(!navigator.geolocation){
    setStatus("GPS não suportado.");
    if(el("mapHint")) el("mapHint").textContent = "GPS não suportado.";
    return;
  }

  setStatus("Obtendo localização atual...");
  if(el("mapHint")) el("mapHint").textContent = "Obtendo localização atual...";

  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    currentLocation = { lat, lon };
    selectedLocation = { lat, lon };
    pendingMapSelection = { lat, lon };
    updateCrosshairState();

    if(mapInstance){
      setPendingMapSelection(lat, lon);
      mapInstance.setView([lat, lon], Math.max(mapInstance.getZoom(), 13));
    }

    await refreshWeatherForPosition(lat, lon, { source:"current" });
  }, err => {
    setStatus("Erro no GPS: " + err.message);
    if(el("mapHint")) el("mapHint").textContent = "Erro no GPS: " + err.message;
  }, { enableHighAccuracy:true, timeout:12000, maximumAge:30000 });
}
