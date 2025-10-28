import React, { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import {
  ALL_GAME_FISH,
  top20ForType,
  successScore,
  suggestGear,
  bboxFromCenterRadius,
  cacheGet,
  cacheSet,
  haversineMiles,
  bestWindows,
} from "./lib.js";

// Core API endpoints
const USGS_SITE_URL = "https://waterservices.usgs.gov/nwis/site/";
const USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function useGeolocation() {
  const [pos, setPos] = useState(null);
  const [err, setErr] = useState(null);

  const get = () => {
    if (!navigator.geolocation) {
      setErr("Geolocation not supported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      (e) => setErr(e.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  };

  return { pos, err, get };
}

function Map({ center, wb, radiusMi }) {
  useEffect(() => {
    const map = L.map("map", { attributionControl: true }).setView(
      [center.lat, center.lon],
      10
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);
    L.marker([center.lat, center.lon]).addTo(map).bindPopup("Your location");
    L.circle([center.lat, center.lon], {
      radius: radiusMi * 1609.344,
      color: "#60a5fa",
    }).addTo(map);
    if (wb) {
      L.marker([wb.lat, wb.lon])
        .addTo(map)
        .bindPopup(`${wb.name}`);
      map.fitBounds(L.latLngBounds([[center.lat, center.lon], [wb.lat, wb.lon]]), {
        padding: [30, 30],
      });
    }
    return () => map.remove();
  }, [center.lat, center.lon, wb?.lat, wb?.lon, radiusMi]);

  return (
    <div
      id="map"
      className="w-full h-80 bg-slate-800"
      aria-label="Map of location and water body"
    />
  );
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

  const r = await fetch(url);
  const j = await r.json();
  const list = (j?.value?.site || [])
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
    }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));

  list.sort(
    (a, b) =>
      haversineMiles(center, { lat: a.lat, lon: a.lon }) -
      haversineMiles(center, { lat: b.lat, lon: b.lon })
  );

  cacheSet(key, list, 6 * 60 * 60 * 1000);
  return list;
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

  const r = await fetch(url);
  const j = await r.json();
  const out = { flowCfs: null, stageFt: null, waterTempF: null, turbidityFnu: null };
  const ts = j?.value?.timeSeries || [];
  ts.forEach((s) => {
    const code = s?.variable?.variableCode?.[0]?.value;
    const val = parseFloat(s?.values?.[0]?.value?.[0]?.value);
    if (code === "00060") out.flowCfs = val;
    if (code === "00065") out.stageFt = val;
    if (code === "00010") out.waterTempF = val * 9 / 5 + 32;
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
  const qParts = [];
  if (types.includes("boat_ramp")) qParts.push('node["amenity"="boat_ramp"]');
  if (types.includes("shop_fishing")) qParts.push('node["shop"="fishing"]');
  if (qParts.length === 0) return [];
  const query = `[out:json][timeout:25];(${qParts.join(
    ";"
  )}(around:${radiusM},${lat},${lon}););out body;`;
  const key = `pois:${lat.toFixed(3)},${lon.toFixed(3)}:${radiusMi}:${types.join(",")}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  });
  const j = await r.json();
  const items = (j.elements || []).map((e) => ({
    id: e.id,
    lat: e.lat,
    lon: e.lon,
    name: e.tags?.name || e.tags?.brand || "(Unnamed)",
    type: e.tags?.amenity || e.tags?.shop,
  }));
  cacheSet(key, items, 12 * 60 * 60 * 1000);
  return items;
}

export default function App() {
  const { pos, get } = useGeolocation();
  const [centerText, setCenterText] = useState("");
  const [center, setCenter] = useState(null);
  const [radius, setRadius] = useState(25);
  const [dateIso, setDateIso] = useState(() => new Date().toISOString());
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [siteInfo, setSiteInfo] = useState(null);
  const [species, setSpecies] = useState("Largemouth Bass");
  const [wx, setWx] = useState(null);
  const [hydro, setHydro] = useState(null);
  const [pois, setPois] = useState([]);
  const [showBait, setShowBait] = useState(true);
  const [showRamps, setShowRamps] = useState(true);

  useEffect(() => {
    if (pos && !center) {
      setCenter(pos);
      setCenterText(`${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`);
    }
  }, [pos]);

  useEffect(() => {
    if (!center) return;
    (async () => {
      const s = await fetchUSGSSites(center, radius);
      setSites(s);
      if (s[0]) {
        setSelectedSiteId(s[0].id);
        setSiteInfo(s[0]);
      }
      const p = await fetchPOIs(
        center.lat,
        center.lon,
        Math.min(radius, 10),
        [showRamps ? "boat_ramp" : null, showBait ? "shop_fishing" : null].filter(Boolean)
      );
      setPois(p);
    })();
  }, [center, radius, showBait, showRamps]);

  useEffect(() => {
    if (!selectedSiteId) return;
    const s = sites.find((x) => x.id === selectedSiteId);
    if (s) setSiteInfo(s);
  }, [selectedSiteId, sites]);

  useEffect(() => {
    if (!siteInfo || !dateIso) return;
    (async () => {
      const wxData = await fetchWeather(siteInfo.lat, siteInfo.lon, dateIso);
      setWx(wxData);
      const h = await fetchUSGSConditions(siteInfo.id);
      setHydro(h);
    })();
  }, [siteInfo?.id, dateIso]);

  const hourNow = new Date().getHours();
  const measured = {
    waterTempF: hydro?.waterTempF ?? null,
    turbidityFnu: hydro?.turbidityFnu ?? null,
  };

  const derived = useMemo(() => {
    if (!wx) return null;
    const avgAir =
      wx.hourly.reduce((a, b) => a + (b.airTempF || 0), 0) /
      Math.max(wx.hourly.length, 1);
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

  const score = useMemo(
    () => (derived && siteInfo ? successScore(species, siteInfo.type, derived) : null),
    [derived, species, siteInfo]
  );
  const gear = useMemo(
    () => (derived && siteInfo ? suggestGear(species, siteInfo.type, derived) : null),
    [derived, species, siteInfo]
  );

  const bestTimes = useMemo(() => {
    if (!wx) return [];
    return bestWindows({
      sunriseTs: wx.daily.sunriseTs,
      sunsetTs: wx.daily.sunsetTs,
      hourly: wx.hourly,
    });
  }, [wx]);

  function parseCenter() {
    const m = centerText
      .trim()
      .match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if (!m) {
      alert("Enter coordinates like '40.558,-85.659' or use Current Location.");
      return;
    }
    setCenter({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) });
  }

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Fishing Predictor</h1>
        <p className="text-slate-300 text-sm">
          Live weather (Open-Meteo), hydrology (USGS), and simple fish-behavior
          rules. Runs entirely client-side. (Offline/PWA disabled for GitHub
          Pages.)
        </p>
      </header>

      {/* App sections would render here (same as your prior layout) */}
    </div>
  );
}
