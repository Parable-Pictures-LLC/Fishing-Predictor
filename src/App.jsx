import React, { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import {
  ALL_GAME_FISH,
  top20ForType,          // we’ll filter this further with temp logic
  successScore,
  suggestGear,
  bboxFromCenterRadius,
  cacheGet,
  cacheSet,
  haversineMiles,
  bestWindows,
} from "./lib.js";

const USGS_SITE_URL = "https://waterservices.usgs.gov/nwis/site/";
const USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// --------- Geolocation hook ----------
function useGeolocation() {
  const [pos, setPos] = useState(null);
  const [err, setErr] = useState(null);
  const get = () => {
    if (!navigator.geolocation) {
      setErr("Geolocation not supported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => setErr(e.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  };
  return { pos, err, get };
}

// --------- Leaflet Map (click to set center) ----------
function Map({ center, wb, radiusMi, onMapClick }) {
  useEffect(() => {
    const map = L.map("map", { attributionControl: true }).setView(
      [center.lat, center.lon],
      10
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);

    const centerMarker = L.marker([center.lat, center.lon]).addTo(map);
    centerMarker.bindPopup("Your location");

    L.circle([center.lat, center.lon], {
      radius: radiusMi * 1609.344,
      color: "#60a5fa",
    }).addTo(map);

    let wbMarker = null;
    if (wb && wb.lat && wb.lon) {
      wbMarker = L.marker([wb.lat, wb.lon]).addTo(map).bindPopup(`${wb.name}`);
      map.fitBounds(L.latLngBounds([[center.lat, center.lon], [wb.lat, wb.lon]]), {
        padding: [30, 30],
      });
    }

    const handleClick = (e) => {
      onMapClick && onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng });
    };
    map.on("click", handleClick);

    return () => {
      map.off("click", handleClick);
      if (wbMarker) wbMarker.remove();
      map.remove();
    };
  }, [center.lat, center.lon, wb?.lat, wb?.lon, radiusMi, onMapClick]);

  return (
    <div
      id="map"
      className="w-full h-80 bg-slate-800"
      aria-label="Map of location and water body"
    />
  );
}

// --------- Helpers: Overpass, USGS, Weather, POIs ----------
async function fetchOverpass(query) {
  let lastErr = null;
  for (const base of OVERPASS_MIRRORS) {
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: query,
      });
      if (!r.ok) throw new Error(`Overpass ${base} HTTP ${r.status}`);
      const j = await r.json();
      console.info("[OSM] Overpass ok:", base, "elements:", j?.elements?.length ?? 0);
      return j;
    } catch (e) {
      console.warn("[OSM] Overpass failed:", base, e);
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Overpass mirrors failed");
}

async function fetchUSGSSites(center, radiusMi) {
  const bbox = bboxFromCenterRadius(center.lat, center.lon, radiusMi);
  const params = new URLSearchParams({
    format: "json",
    bBox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    siteType: "ST,ST-TS,LA,RES",
    siteStatus: "active",
  });
  const url = `${USGS_SITE_URL}?${params.toString()}`;
  const key = `sites:${params.toString()}`;

  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    console.info("[USGS] Fetch:", url);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`USGS HTTP ${r.status}`);
    const j = await r.json();
    let list = (j?.value?.site || [])
      .map((s) => ({
        id: s.siteCode?.[0]?.value,
        name: s.siteName,
        lat: parseFloat(s.geoLocation?.geogLocation?.latitude),
        lon: parseFloat(s.geoLocation?.geogLocation?.longitude),
        type: (s.siteType?.[0]?.value || "").match(/Lake|Reservoir/i)
          ? "Lake"
          : (s.siteType?.[0]?.value || "").match(/Stream|River/i)
          ? "River"
          : "Water",
        source: "USGS",
      }))
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));

    console.info("[USGS] Sites returned:", list.length);

    if (list.length === 0) {
      const radiusM = Math.floor(radiusMi * 1609.344);
      const { lat, lon } = center;
      const query = `[out:json][timeout:25];
        (
          way["natural"="water"](around:${radiusM},${lat},${lon});
          way["water"="lake"](around:${radiusM},${lat},${lon});
          way["water"="reservoir"](around:${radiusM},${lat},${lon});
          way["waterway"="river"](around:${radiusM},${lat},${lon});
        );
        out center;`;
      const jj = await fetchOverpass(query);
      list = (jj.elements || [])
        .map((e) => ({
          id: String(e.id),
          name: e.tags?.name || "Unnamed Water",
          lat: e.center?.lat || e.lat,
          lon: e.center?.lon || e.lon,
          type: e.tags?.waterway ? "River" : e.tags?.water || "Water",
          source: "OSM",
        }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
      console.info("[OSM] Water bodies:", list.length);
    }

    list.sort(
      (a, b) =>
        haversineMiles(center, { lat: a.lat, lon: a.lon }) -
        haversineMiles(center, { lat: b.lat, lon: b.lon })
    );

    cacheSet(key, list, 6 * 60 * 60 * 1000);
    return list;
  } catch (err) {
    console.error("[USGS] Fetch error, falling back to OSM:", err);
    try {
      const radiusM = Math.floor(radiusMi * 1609.344);
      const { lat, lon } = center;
      const query = `[out:json][timeout:25];
        (
          way["natural"="water"](around:${radiusM},${lat},${lon});
          way["water"="lake"](around:${radiusM},${lat},${lon});
          way["water"="reservoir"](around:${radiusM},${lat},${lon});
          way["waterway"="river"](around:${radiusM},${lat},${lon});
        );
        out center;`;
      const jj = await fetchOverpass(query);
      const list = (jj.elements || [])
        .map((e) => ({
          id: String(e.id),
          name: e.tags?.name || "Unnamed Water",
          lat: e.center?.lat || e.lat,
          lon: e.center?.lon || e.lon,
          type: e.tags?.waterway ? "River" : e.tags?.water || "Water",
          source: "OSM",
        }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .sort(
          (a, b) =>
            haversineMiles(center, { lat: a.lat, lon: a.lon }) -
            haversineMiles(center, { lat: b.lat, lon: b.lon })
        );
      console.info("[OSM] Fallback water bodies:", list.length);
      cacheSet(key, list, 6 * 60 * 60 * 1000);
      return list;
    } catch (osmErr) {
      console.error("[OSM] Fallback failed:", osmErr);
      return [];
    }
  }
}

async function fetchUSGSConditions(siteId) {
  const params = new URLSearchParams({
    format: "json",
    parameterCd: "00060,00065,00010,63680",
    sites: siteId,
  });
  const url = `${USGS_IV_URL}?${params.toString()}`;
  const key = `iv:${siteId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  console.info("[USGS] Conditions:", siteId);
  const r = await fetch(url);
  const j = await r.json();
  const out = { flowCfs: null, stageFt: null, waterTempF: null, turbidityFnu: null };
  const ts = j?.value?.timeSeries || [];
  ts.forEach((s) => {
    const code = s?.variable?.variableCode?.[0]?.value;
    const val = parseFloat(s?.values?.[0]?.value?.[0]?.value);
    if (code === "00060") out.flowCfs = val;
    if (code === "00065") out.stageFt = val;
    if (code === "00010") out.waterTempF = (val * 9) / 5 + 32;
    if (code === "63680") out.turbidityFnu = val;
  });
  cacheSet(key, out, 60 * 60 * 1000);
  return out;
}

async function fetchWeather(lat, lon, dateISO) {
  const d = new Date(dateISO);
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth() + 1,
    day = d.getUTCDate();
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "temperature_2m,cloudcover,windspeed_10m,pressure_msl",
    daily: "sunrise,sunset",
    start_date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    end_date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timezone: "auto",
  });
  const url = `${OPEN_METEO_URL}?${params.toString()}`;
  const key = `wx:${lat.toFixed(3)},${lon.toFixed(3)}:${dateISO}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  console.info("[WX] Fetch:", lat.toFixed(3), lon.toFixed(3), dateISO.slice(0, 10));
  const r = await fetch(url);
  const j = await r.json();
  const hourly = (j?.hourly?.time || []).map((t, i) => ({
    time: t,
    airTempF: Math.round(((j.hourly.temperature_2m?.[i] ?? 0) * 9) / 5 + 32),
    windMph: Math.round((j.hourly.windspeed_10m?.[i] ?? 0) * 0.621371),
    cloudPct: Math.round(j.hourly.cloudcover?.[i] ?? 0),
    pressure_msl: j.hourly.pressure_msl?.[i],
  }));
  const sunrise = j?.daily?.sunrise?.[0];
  const sunset = j?.daily?.sunset?.[0];
  const daily = {
    sunriseTs: sunrise ? new Date(sunrise).getTime() : null,
    sunsetTs: sunset ? new Date(sunset).getTime() : null,
  };
  const out = { hourly, daily };
  cacheSet(key, out, 60 * 60 * 1000);
  return out;
}

async function fetchPOIs(lat, lon, radiusMi, types = ["boat_ramp", "shop_fishing"]) {
  const radiusM = Math.floor(radiusMi * 1609.344);
  const parts = [];
  if (types.includes("boat_ramp")) parts.push('node["amenity"="boat_ramp"]');
  if (types.includes("shop_fishing")) parts.push('node["shop"="fishing"]');
  if (parts.length === 0) return [];
  const query = `[out:json][timeout:25];(${parts
    .map((p) => `${p}(around:${radiusM},${lat},${lon});`)
    .join(" ")})out body;`;
  const key = `pois:${lat.toFixed(3)},${lon.toFixed(3)}:${radiusMi}:${types.join(",")}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const j = await fetchOverpass(query);
    const items = (j.elements || []).map((e) => ({
      id: e.id,
      lat: e.lat,
      lon: e.lon,
      name: e.tags?.name || e.tags?.brand || "(Unnamed)",
      type: e.tags?.amenity || e.tags?.shop,
    }));
    cacheSet(key, items, 12 * 60 * 60 * 1000);
    console.info("[POI] count:", items.length);
    return items;
  } catch (e) {
    console.warn("[POI] Overpass failed:", e);
    return [];
  }
}

// --------- New: Geocoding (City/State / Landmark) ----------
async function geocodePlace(q) {
  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "1",
    addressdetails: "0",
  });
  const url = `${NOMINATIM_URL}?${params.toString()}`;
  console.info("[Geo] Geocoding:", q);
  const r = await fetch(url, {
    headers: { "Accept-Language": "en" }, // keep results consistent
  });
  if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
  const arr = await r.json();
  if (!arr || arr.length === 0) return null;
  const { lat, lon } = arr[0];
  return { lat: parseFloat(lat), lon: parseFloat(lon) };
}

// --------- New: Warm/Cold filtering helpers ----------
function getWaterTempForLogic(derived, hydro) {
  // Prefer measured water temp; else estimated from air
  return (hydro?.waterTempF ?? derived?.waterTempF ?? null);
}

// Rule-of-thumb thresholds: colder for rivers (moving water), slightly warmer for lakes
function isColdWater(waterType, waterTempF) {
  if (!Number.isFinite(waterTempF)) return null; // unknown
  if (/River|Stream/i.test(waterType)) return waterTempF < 60;
  return waterTempF < 55; // Lake/Reservoir/Water
}

// Curated species sets (subset from ALL_GAME_FISH) for better realism
const WARM_SET = [
  "Largemouth Bass","Smallmouth Bass","Striped Bass","White Bass","Walleye",
  "Crappie","Bluegill","Sunfish","Perch","Catfish","Carp","Hybrid Striper","Northern Pike","Muskellunge"
];

const COLD_SET = [
  "Rainbow Trout","Brown Trout","Brook Trout","Lake Trout","Steelhead",
  "Walleye","Perch","Northern Pike","Muskellunge","Smallmouth Bass"
];

// Filter base list by temperature profile
function top20ForTypeAndTemp(waterType, waterTempF) {
  const base = top20ForType(waterType || "Water");
  const cold = isColdWater(waterType || "Water", waterTempF);
  if (cold === null) {
    // Unknown temp → keep base but cap at 20
    return base.slice(0, 20);
  }
  const allow = cold ? COLD_SET : WARM_SET;
  // Keep species that are in both base and allowed set, then fill with base remainder
  const primary = base.filter(s => allow.includes(s));
  const remainder = base.filter(s => !primary.includes(s));
  return [...primary, ...remainder].slice(0, 20);
}

// Normalize species name for recognition
function normName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const KNOWN_SET = new Set(ALL_GAME_FISH.map(normName));

// ======================= App =======================
export default function App() {
  const { pos, get } = useGeolocation();

  // Location & geocoding
  const [center, setCenter] = useState(null);
  const [searchText, setSearchText] = useState(""); // city/state/landmark
  const [geoError, setGeoError] = useState("");

  // Controls & data
  const [radius, setRadius] = useState(25);
  const [dateIso, setDateIso] = useState(() => new Date().toISOString());
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState("center"); // default to Current Location
  const [siteInfo, setSiteInfo] = useState(null);

  const [species, setSpecies] = useState("Largemouth Bass"); // dropdown choice
  const [customSpecies, setCustomSpecies] = useState("");     // typed override
  const [unknownCustom, setUnknownCustom] = useState(false);

  const [wx, setWx] = useState(null);
  const [hydro, setHydro] = useState(null);
  const [pois, setPois] = useState([]);
  const [showBait, setShowBait] = useState(true);
  const [showRamps, setShowRamps] = useState(true);

  // Synthetic "Current Location" site
  const syntheticFromCenter = useMemo(() => {
    if (!center) return null;
    return {
      id: "center",
      name: "Current Location",
      lat: center.lat,
      lon: center.lon,
      type: "Water",
      source: "CENTER",
    };
  }, [center]);

  // Init from browser geolocation (if allowed)
  useEffect(() => {
    if (pos && !center) {
      setCenter(pos);
    }
  }, [pos, center]);

  // Refetch nearby sites + POIs when center/radius/toggles change
  useEffect(() => {
    if (!center) return;
    (async () => {
      // Default selected site = Current Location
      setSiteInfo({
        id: "center",
        name: "Current Location",
        lat: center.lat,
        lon: center.lon,
        type: "Water",
        source: "CENTER",
      });

      const s = await fetchUSGSSites(center, radius);
      setSites(s);

      const p = await fetchPOIs(
        center.lat,
        center.lon,
        Math.min(radius, 10),
        [showRamps ? "boat_ramp" : null, showBait ? "shop_fishing" : null].filter(Boolean)
      );
      setPois(p);
    })();
  }, [center, radius, showBait, showRamps]);

  // Keep siteInfo in sync when selection changes
  useEffect(() => {
    if (!center) return;
    if (selectedSiteId === "center") {
      setSiteInfo(syntheticFromCenter);
      return;
    }
    const s = sites.find((x) => x.id === selectedSiteId);
    if (s) setSiteInfo(s);
  }, [selectedSiteId, sites, syntheticFromCenter, center]);

  // Weather + hydrology on site/date change
  useEffect(() => {
    if (!siteInfo || !dateIso) return;
    (async () => {
      const wxData = await fetchWeather(siteInfo.lat, siteInfo.lon, dateIso);
      setWx(wxData);
      if (siteInfo.source === "USGS") {
        const h = await fetchUSGSConditions(siteInfo.id);
        setHydro(h);
      } else {
        setHydro(null);
      }
    })();
  }, [siteInfo?.id, siteInfo?.lat, siteInfo?.lon, siteInfo?.source, dateIso]);

  // Derived conditions
  const hourNow = new Date().getHours();
  const measured = {
    waterTempF: hydro?.waterTempF ?? null,
    turbidityFnu: hydro?.turbidityFnu ?? null,
  };

  const derived = useMemo(() => {
    if (!wx) return null;
    const avgAir =
      wx.hourly.reduce((a, b) => a + (b.airTempF || 0), 0) / Math.max(wx.hourly.length, 1);
    const estWater = measured.waterTempF ?? Math.round(avgAir - 5);
    const windNow = wx.hourly[hourNow]?.windMph ?? 5;
    const cloudNow = wx.hourly[hourNow]?.cloudPct ?? 50;
    const pressureNow = wx.hourly[hourNow]?.pressure_msl
      ? wx.hourly[hourNow].pressure_msl * 0.02953
      : 29.92;
    const turb = measured.turbidityFnu ?? null;
    return {
      waterTempF: estWater,
      windMph: windNow,
      cloudPct: cloudNow,
      barometerInHg: Math.round(pressureNow * 100) / 100,
      turbidityFnu: turb,
      estimated: !measured.waterTempF,
    };
  }, [wx, measured.waterTempF, measured.turbidityFnu, hourNow]);

  // Compute temperature profile for species filtering
  const logicWaterTempF = getWaterTempForLogic(derived, hydro);
  const filteredSpeciesList = useMemo(() => {
    return top20ForTypeAndTemp(siteInfo?.type || "Water", logicWaterTempF);
  }, [siteInfo?.type, logicWaterTempF]);

  // Effective species (typed overrides dropdown)
  const effectiveSpecies = useMemo(() => {
    const typed = customSpecies.trim();
    if (typed.length === 0) {
      setUnknownCustom(false);
      return species;
    }
    const known = KNOWN_SET.has(normName(typed));
    setUnknownCustom(!known);
    console.info("[Species] Using custom:", typed, "known?", known);
    return typed;
  }, [customSpecies, species]);

  const selectedWaterType = siteInfo?.type || "Water";
  const score = useMemo(
    () => (derived && siteInfo ? successScore(effectiveSpecies, selectedWaterType, derived) : null),
    [derived, effectiveSpecies, selectedWaterType, siteInfo]
  );
  const gear = useMemo(
    () => (derived && siteInfo ? suggestGear(effectiveSpecies, selectedWaterType, derived) : null),
    [derived, effectiveSpecies, selectedWaterType, siteInfo]
  );

  const bestTimes = useMemo(() => {
    if (!wx) return [];
    return bestWindows({
      sunriseTs: wx.daily.sunriseTs,
      sunsetTs: wx.daily.sunsetTs,
      hourly: wx.hourly,
    });
  }, [wx]);

  function mapsLinksFor(site) {
    if (!site) return null;
    const q = `${site.lat},${site.lon}`;
    return {
      google: `https://www.google.com/maps/search/?api=1&query=${q}`,
      apple: `maps://?q=${q}`,
    };
  }
  const mapsLinks = mapsLinksFor(siteInfo);

  async function handleFindPlace() {
    setGeoError("");
    const q = searchText.trim();
    if (!q) return;
    try {
      const ll = await geocodePlace(q);
      if (!ll) {
        setGeoError("Couldn’t find that location. Try city and state (e.g., Boise, Idaho).");
        return;
      }
      console.info("[Geo] Found:", ll);
      setCenter(ll);
      setSelectedSiteId("center");
    } catch (e) {
      console.error("[Geo] Error:", e);
      setGeoError("Search failed. Please try again in a moment.");
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold">Fishing Predictor</h1>
        <p className="text-slate-300 text-sm">
          Brought to you by Mike Jones and Jim Weaver. May your lure always find a fish! Copyright 2025.
        </p>
      </header>

      <section className="grid md:grid-cols-3 gap-4">
        {/* Location */}
        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Location</h2>

          <div className="flex gap-2">
            <button
              className="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded"
              onClick={() => { get(); }}
            >
              Use Current Location
            </button>
            {center && (
              <span className="text-xs text-slate-400 self-center">
                {center.lat.toFixed(3)}, {center.lon.toFixed(3)}
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-800 rounded px-3 py-2 outline-none"
              placeholder="City / State or Landmark (e.g., Marion, Indiana)"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              aria-label="City or state or landmark"
            />
            <button className="bg-blue-500 hover:bg-blue-600 px-3 py-2 rounded" onClick={handleFindPlace}>
              Find
            </button>
          </div>
          {geoError && <div className="text-xs text-yellow-300">{geoError}</div>}

          <label className="block text-sm mt-2">Travel radius: {radius} mi</label>
          <input
            aria-label="Radius"
            type="range"
            min="10"
            max="100"
            step="5"
            value={radius}
            onChange={(e) => {
              setRadius(parseInt(e.target.value));
              setSelectedSiteId("center");
            }}
            className="w-full"
          />

          <label className="block text-sm mt-2">Fishing date</label>
          <select
            className="w-full bg-slate-800 rounded px-3 py-2"
            value={dateIso}
            onChange={(e) => setDateIso(e.target.value)}
            aria-label="Date selector"
          >
            {[...Array(8).keys()].map((d) => {
              const dt = new Date();
              dt.setDate(dt.getDate() + d);
              const iso = dt.toISOString();
              return (
                <option key={d} value={iso}>
                  {d === 0 ? "Today" : dt.toLocaleDateString()}
                </option>
              );
            })}
          </select>
        </div>

        {/* Water Body */}
        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Water Body</h2>
          <p className="text-xs text-slate-400">Tip: Click anywhere on the map to set your location manually.</p>

          <select
            className="w-full bg-slate-800 rounded px-3 py-2"
            value={selectedSiteId}
            onChange={(e) => setSelectedSiteId(e.target.value)}
            aria-label="Water body selector"
          >
            <option value="center">Current Location</option>
            {sites.length === 0 && (
              <option value="__nodata" disabled>
                No nearby water bodies found.
              </option>
            )}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.type} · {center ? haversineMiles(center, { lat: s.lat, lon: s.lon }).toFixed(1) : "?"} mi {s.source === "OSM" ? "(OSM)" : ""}
              </option>
            ))}
          </select>

          {siteInfo && (
            <div className="text-xs text-slate-300 space-y-1">
              <div><strong>Name:</strong> {siteInfo.name}</div>
              <div><strong>Type:</strong> {siteInfo.type}</div>
              <div><strong>Coords:</strong> {siteInfo.lat.toFixed(4)}, {siteInfo.lon.toFixed(4)}</div>
              <div className="flex gap-3 mt-2">
                <a className="underline" href={mapsLinks?.google} target="_blank" rel="noreferrer">Open in Google Maps</a>
                <a className="underline" href={mapsLinks?.apple}>Open in Apple Maps</a>
              </div>
            </div>
          )}

          <div className="mt-3">
            {center && (
              <Map
                center={center}
                wb={siteInfo}
                radiusMi={radius}
                onMapClick={(pt) => {
                  setCenter(pt);
                  setSelectedSiteId("center");
                }}
              />
            )}
          </div>
        </div>

        {/* Species & Predictions */}
        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Target Species</h2>

          <select
            className="w-full bg-slate-800 rounded px-3 py-2"
            value={species}
            onChange={(e) => setSpecies(e.target.value)}
            aria-label="Species selector"
          >
            {filteredSpeciesList.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <input
            className="mt-2 w-full bg-slate-800 rounded px-3 py-2 outline-none"
            placeholder="Or type a specific fish species"
            value={customSpecies}
            onChange={(e) => setCustomSpecies(e.target.value)}
            aria-label="Type a specific fish species"
          />
          <div className="text-xs text-slate-400">
            Species list estimated for {isColdWater(selectedWaterType, logicWaterTempF) ? "cold" : "warm"}-water conditions based on temperature.
          </div>
          {unknownCustom && (
            <div className="text-xs text-yellow-300 mt-1">Unknown species — using general freshwater model.</div>
          )}

          {wx && siteInfo && (
            <div className="mt-3 bg-slate-800 rounded p-3">
              <div className="flex flex-wrap gap-3 text-sm">
                <span>
                  Water{" "}
                  {(hydro?.waterTempF ? Math.round(hydro.waterTempF) : Math.round(derived?.waterTempF ?? 0))}°F{" "}
                  {derived?.estimated && !hydro?.waterTempF ? <em className="text-yellow-300">(estimated)</em> : null}
                </span>
                <span>Wind {derived?.windMph ?? "…"} mph</span>
                <span>Pressure {derived?.barometerInHg ?? "…"} inHg</span>
                {hydro?.flowCfs != null && <span>Flow {hydro.flowCfs} cfs</span>}
                {derived?.turbidityFnu != null && <span>Turbidity {derived.turbidityFnu} FNU</span>}
              </div>
              <div className="mt-2">
                <span
                  className={`px-2 py-1 rounded text-sm ${
                    (score ?? 0) >= 70 ? "bg-green-600" : (score ?? 0) >= 40 ? "bg-yellow-600" : "bg-red-600"
                  }`}
                >
                  Success: {score ?? "…"}%
                </span>
              </div>
              {gear && (
                <div className="mt-3 space-y-2 text-sm">
                  <div><strong>Rod:</strong> {gear.rodAndLine}</div>
                  <div>
                    <strong>Lures/Baits:</strong>
                    <ul className="list-disc pl-5">
                      {gear.lures.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </div>
                  <div>
                    <strong>Locations:</strong>
                    <ul className="list-disc pl-5">
                      {gear.locations.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {bestTimes.length > 0 && (
            <div className="mt-3 bg-slate-800 rounded p-3 text-sm">
              <div className="font-semibold mb-1">Best Times (today)</div>
              <ul className="list-disc pl-5">
                {bestTimes.map((b, i) => (
                  <li key={i}>
                    {new Date(b.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · score {b.score}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="bg-slate-900 p-4 rounded-xl">
        <h2 className="font-semibold mb-2">Nearby Access</h2>
        <p className="text-xs text-slate-400">From OpenStreetMap via Overpass (free). Click to navigate.</p>
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          {pois.map((p) => (
            <a
              key={p.id}
              className="block bg-slate-800 rounded p-3 hover:bg-slate-700"
              href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`}
              target="_blank"
              rel="noreferrer"
            >
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-xs text-slate-400">
                {p.type} · {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
              </div>
            </a>
          ))}
        </div>
      </section>

      <footer className="text-xs text-slate-500 text-center py-6">
        v1.0 • Data: Open-Meteo, USGS, OpenStreetMap. Some values may be estimated when hydrology is unavailable.
      </footer>
    </div>
  );
}
