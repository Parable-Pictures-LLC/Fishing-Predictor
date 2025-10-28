import React, { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { 
  ALL_GAME_FISH, 
  top20ForType, 
  successScore, 
  suggestGear, 
  cacheGet, 
  cacheSet, 
  haversineMiles, 
  bestWindows 
} from './lib.js'

const USGS_SITE_URL = 'https://waterservices.usgs.gov/nwis/site/';
const USGS_IV_URL = 'https://waterservices.usgs.gov/nwis/iv/';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

function useGeolocation(){
  const [pos,setPos]=useState(null); 
  const [err,setErr]=useState(null);
  const get=()=>{
    if(!navigator.geolocation){ 
      setErr('Geolocation not supported'); 
      return; 
    }
    navigator.geolocation.getCurrentPosition(p=>{
      setPos({lat:p.coords.latitude, lon:p.coords.longitude});
    }, e=>setErr(e.message), { enableHighAccuracy:true, timeout:10000, maximumAge:10000 });
  }
  return { pos, err, get };
}

function Map({ center, wb, radiusMi }){
  useEffect(()=>{
    const map = L.map('map', { attributionControl:true }).setView([center.lat, center.lon], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    L.marker([center.lat, center.lon]).addTo(map).bindPopup('Your location');
    L.circle([center.lat, center.lon], { radius: radiusMi*1609.344, color:'#60a5fa' }).addTo(map);
    if(wb){ 
      L.marker([wb.lat, wb.lon]).addTo(map).bindPopup(`${wb.name}`); 
      map.fitBounds(L.latLngBounds([[center.lat,center.lon],[wb.lat,wb.lon]]) , { padding:[30,30]}); 
    }
    return ()=>map.remove();
  },[center.lat, center.lon, wb?.lat, wb?.lon, radiusMi]);
  return <div id="map" className="w-full h-80 bg-slate-800" aria-label="Map of location and water body" />
}

async function fetchUSGSSites(center, radiusMi){
  const { lat, lon } = center;
  const delta = radiusMi / 69; // ~69 miles per degree latitude
  const minLat = lat - delta;
  const maxLat = lat + delta;
  const minLon = lon - (delta / Math.cos(lat * Math.PI / 180));
  const maxLon = lon + (delta / Math.cos(lat * Math.PI / 180));

  const params = new URLSearchParams({
    format:'json',
    bBox: `${minLon},${minLat},${maxLon},${maxLat}`,
    siteType:'ST,ST-TS,LA,RES',
    siteStatus:'active'
  });

  const url = `${USGS_SITE_URL}?${params.toString()}`;
  const key = `sites:${params.toString()}`; 
  const cached = cacheGet(key); 
  if(cached) return cached;

  const r = await fetch(url); 
  const j = await r.json();

  const list = (j?.value?.site || []).map(s=>({
    id: s.siteCode?.[0]?.value,
    name: s.siteName,
    lat: parseFloat(s.geoLocation?.geogLocation?.latitude),
    lon: parseFloat(s.geoLocation?.geogLocation?.longitude),
    type: (s.siteType?.[0]?.value||'').match(/Lake|Reservoir/i)
      ? 'Lake'
      : ((s.siteType?.[0]?.value||'').match(/Stream|River/i)
        ? 'River'
        : 'Water')
  })).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon));

  list.sort((a,b)=>haversineMiles(center,{lat:a.lat,lon:a.lon}) - haversineMiles(center,{lat:b.lat,lon:b.lon}));
  cacheSet(key, list, 6*60*60*1000);
  return list;
}

async function fetchUSGSConditions(siteId){
  const params = new URLSearchParams({ format:'json', parameterCd:'00060,00065,00010,63680', sites:siteId });
  const url = `${USGS_IV_URL}?${params.toString()}`;
  const key = `iv:${siteId}`; 
  const cached = cacheGet(key); 
  if(cached) return cached;
  const r = await fetch(url); 
  const j = await r.json();
  const out = { flowCfs:null, stageFt:null, waterTempF:null, turbidityFnu:null };
  const ts = j?.value?.timeSeries || [];
  ts.forEach(s=>{
    const code = s?.variable?.variableCode?.[0]?.value;
    const val = parseFloat(s?.values?.[0]?.value?.[0]?.value);
    if(code==='00060') out.flowCfs = val;
    if(code==='00065') out.stageFt = val;
    if(code==='00010') out.waterTempF = (val * 9/5) + 32;
    if(code==='63680') out.turbidityFnu = val;
  });
  cacheSet(key, out, 60*60*1000);
  return out;
}

async function fetchWeather(lat,lon,dateISO){
  const d = new Date(dateISO); 
  const y=d.getUTCFullYear(), m=d.getUTCMonth()+1, day=d.getUTCDate();
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: 'temperature_2m,cloudcover,windspeed_10m,pressure_msl',
    daily: 'sunrise,sunset',
    start_date: `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    end_date: `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    timezone: 'auto'
  });
  const url = `${OPEN_METEO_URL}?${params.toString()}`;
  const key = `wx:${lat.toFixed(3)},${lon.toFixed(3)}:${dateISO}`; 
  const cached = cacheGet(key); 
  if(cached) return cached;
  const r = await fetch(url); 
  const j = await r.json();
  const hourly = (j?.hourly?.time || []).map((t,i)=>({
    time: t,
    airTempF: Math.round(((j.hourly.temperature_2m?.[i] ?? 0) * 9/5) + 32),
    windMph: Math.round((j.hourly.windspeed_10m?.[i] ?? 0) * 0.621371),
    cloudPct: Math.round(j.hourly.cloudcover?.[i] ?? 0),
    pressure_msl: j.hourly.pressure_msl?.[i]
  }));
  const sunrise = j?.daily?.sunrise?.[0];
  const sunset = j?.daily?.sunset?.[0];
  const daily = { sunriseTs: sunrise? new Date(sunrise).getTime():null, sunsetTs: sunset? new Date(sunset).getTime():null };
  const out = { hourly, daily };
  cacheSet(key, out, 60*60*1000);
  return out;
}

async function fetchPOIs(lat, lon, radiusMi, types=['boat_ramp','shop_fishing']){
  const radiusM = Math.floor(radiusMi * 1609.344);
  const parts = [];
  if(types.includes('boat_ramp')) parts.push('node["amenity"="boat_ramp"]');
  if(types.includes('shop_fishing')) parts.push('node["shop"="fishing"]');
  if(parts.length === 0) return [];
  const query = `[out:json][timeout:25];(${parts.map(p => `${p}(around:${radiusM},${lat},${lon});`).join(' ')})out body;`;
  const key = `pois:${lat.toFixed(3)},${lon.toFixed(3)}:${radiusMi}:${types.join(',')}`;
  const cached = cacheGet(key); 
  if(cached) return cached;
  const r = await fetch(OVERPASS_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body: query });
  const j = await r.json();
  const items = (j.elements||[]).map(e=>({ 
    id:e.id, 
    lat:e.lat, 
    lon:e.lon, 
    name:e.tags?.name||e.tags?.brand||'(Unnamed)', 
    type: e.tags?.amenity||e.tags?.shop 
  }));
  cacheSet(key, items, 12*60*60*1000);
  return items;
}

export default function App(){
  const { pos, get } = useGeolocation();
  const [centerText,setCenterText]=useState('');
  const [center,setCenter]=useState(null);
  const [radius,setRadius]=useState(25);
  const [dateIso,setDateIso]=useState(()=>new Date().toISOString());
  const [sites,setSites]=useState([]);
  const [selectedSiteId,setSelectedSiteId]=useState('');
  const [siteInfo,setSiteInfo]=useState(null);
  const [species,setSpecies]=useState('Largemouth Bass');
  const [wx,setWx]=useState(null);
  const [hydro,setHydro]=useState(null);
  const [pois,setPois]=useState([]);
  const [showBait,setShowBait]=useState(true);
  const [showRamps,setShowRamps]=useState(true);

  const selectedWaterType = useMemo(()=>{
    if(!siteInfo) return 'Water';
    return siteInfo.type || 'Water';
  },[siteInfo]);

  useEffect(()=>{ 
    if(pos && !center){ 
      setCenter(pos); 
      setCenterText(`${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`); 
    } 
  },[pos]);

  useEffect(()=>{
    if(!center) return;
    (async()=>{
      const s = await fetchUSGSSites(center, radius);
      setSites(s);
      if(s[0]){ setSelectedSiteId(s[0].id); setSiteInfo(s[0]); }
      const p = await fetchPOIs(center.lat, center.lon, Math.min(radius,10), [showRamps?'boat_ramp':null, showBait?'shop_fishing':null].filter(Boolean));
      setPois(p);
    })();
  },[center, radius, showBait, showRamps]);

  useEffect(()=>{
    if(!selectedSiteId) return;
    const s = sites.find(x=>x.id===selectedSiteId); 
    if(s) setSiteInfo(s);
  },[selectedSiteId, sites]);

  useEffect(()=>{
    if(!siteInfo || !dateIso) return;
    (async()=>{
      const wxData = await fetchWeather(siteInfo.lat, siteInfo.lon, dateIso);
      setWx(wxData);
      const h = await fetchUSGSConditions(siteInfo.id);
      setHydro(h);
    })();
  },[siteInfo?.id, dateIso]);

  const hourNow = new Date().getHours();
  const measured = {
    waterTempF: hydro?.waterTempF ?? null,
    turbidityFnu: hydro?.turbidityFnu ?? null,
  };

  const derived = useMemo(()=>{
    if(!wx) return null;
    const avgAir = wx.hourly.reduce((a,b)=>a + (b.airTempF||0), 0) / Math.max(wx.hourly.length,1);
    const estWater = measured.waterTempF ?? Math.round(avgAir - 5);
    const windNow = wx.hourly[hourNow]?.windMph ?? 5;
    const cloudNow = wx.hourly[hourNow]?.cloudPct ?? 50;
    const pressureNow = wx.hourly[hourNow]?.pressure_msl ? (wx.hourly[hourNow].pressure_msl * 0.02953) : 29.92;
    const turb = measured.turbidityFnu ?? null;
    return { waterTempF: estWater, windMph: windNow, cloudPct: cloudNow, barometerInHg: Math.round(pressureNow*100)/100, turbidityFnu: turb, estimated: !measured.waterTempF };
  },[wx, measured.waterTempF, measured.turbidityFnu, hourNow]);

  const score = useMemo(()=> (derived && siteInfo)? successScore(species, siteInfo.type, derived) : null, [derived, species, siteInfo]);
  const gear = useMemo(()=> (derived && siteInfo)? suggestGear(species, siteInfo.type, derived) : null, [derived, species, siteInfo]);

  function parseCenter(){
    const m = centerText.trim().match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if(!m){ alert("Enter coordinates like '40.558,-85.659' or use Current Location."); return; }
    setCenter({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) });
  }

  const mapsLinks = useMemo(()=>{
    if(!siteInfo) return null;
    const { lat, lon } = siteInfo; const q = `${lat},${lon}`;
    return {
      google: `https://www.google.com/maps/search/?api=1&query=${q}`,
      apple: `maps://?q=${q}`
    }
  },[siteInfo]);

  const bestTimes = useMemo(()=>{
    if(!wx) return [];
    return bestWindows({ sunriseTs: wx.daily.sunriseTs, sunsetTs: wx.daily.sunsetTs, hourly: wx.hourly });
  },[wx]);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Fishing Predictor</h1>
        <p className="text-slate-300 text-sm">Live weather (Open-Meteo), hydrology (USGS), and simple fish-behavior rules. Runs entirely client-side. PWA-ready.</p>
      </header>

      <section className="grid md:grid-cols-3 gap-4">
        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Location</h2>
          <div className="flex gap-2">
            <input className="flex-1 bg-slate-800 rounded px-3 py-2 outline-none" placeholder="lat,lon e.g. 40.558,-85.659" value={centerText} onChange={e=>setCenterText(e.target.value)} aria-label="Coordinates input" />
            <button className="bg-blue-500 hover:bg-blue-600 px-3 py-2 rounded" onClick={parseCenter}>Set</button>
          </div>
          <div className="flex gap-2">
            <button className="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded" onClick={get}>Use Current Location</button>
            {center && <span className="text-xs text-slate-400 self-center">{center.lat.toFixed(3)}, {center.lon.toFixed(3)}</span>}
          </div>

          <label className="block text-sm mt-2">Travel radius: {radius} mi</label>
          <input aria-label="Radius" type="range" min="10" max="100" step="5" value={radius} onChange={e=>setRadius(parseInt(e.target.value))} className="w-full" />

          <label className="block text-sm mt-2">Fishing date</label>
          <select className="w-full bg-slate-800 rounded px-3 py-2" value={dateIso} onChange={e=>setDateIso(e.target.value)} aria-label="Date selector">
            {[...Array(8).keys()].map(d=>{ const dt=new Date(); dt.setDate(dt.getDate()+d); const iso=dt.toISOString(); return <option key={d} value={iso}>{d===0?'Today':dt.toLocaleDateString()}</option> })}
          </select>

          <div className="flex items-center gap-3 mt-3">
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={showRamps} onChange={e=>setShowRamps(e.target.checked)} />Boat ramps</label>
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={showBait} onChange={e=>setShowBait(e.target.checked)} />Bait shops</label>
          </div>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Water Body</h2>
          <p className="text-xs text-slate-400">USGS monitoring sites within your radius (active lakes/streams/reservoirs).</p>
          <select className="w-full bg-slate-800 rounded px-3 py-2" value={selectedSiteId} onChange={e=>setSelectedSiteId(e.target.value)} aria-label="Water body selector">
            {sites.map(s=> (
              <option key={s.id} value={s.id}>{s.name} · {s.type} · {center?haversineMiles(center,{lat:s.lat,lon:s.lon}).toFixed(1):'?'} mi</option>
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
            {center && <Map center={center} wb={siteInfo} radiusMi={radius} />}
          </div>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl space-y-3">
          <h2 className="font-semibold">Target Species</h2>
          <select className="w-full bg-slate-800 rounded px-3 py-2" value={species} onChange={e=>setSpecies(e.target.value)} aria-label="Species selector">
            {(siteInfo? top20ForType(siteInfo.type): ALL_GAME_FISH).map(s=> <option key={s} value={s}>{s}</option>)}
          </select>

          {wx && siteInfo && (
            <div className="mt-3 bg-slate-800 rounded p-3">
              <div className="flex flex-wrap gap-3 text-sm">
                <span>Water {(hydro?.waterTempF ? Math.round(hydro.waterTempF) : Math.round(derived.waterTempF))}°F {derived?.estimated && !hydro?.waterTempF ? <em className="text-yellow-300">(estimated)</em> : null}</span>
                <span>Wind {derived?.windMph ?? '…'} mph</span>
                <span>Pressure {derived?.barometerInHg ?? '…'} inHg</span>
                {hydro?.flowCfs!=null && <span>Flow {hydro.flowCfs} cfs</span>}
                {derived?.turbidityFnu!=null && <span>Turbidity {derived.turbidityFnu} FNU</span>}
              </div>
              <div className="mt-2">
                <span className={`px-2 py-1 rounded text-sm ${ (score??0)>=70 ? 'bg-green-600' : (score??0)>=40 ? 'bg-yellow-600' : 'bg-red-600'}`}>Success: {score ?? '…'}%</span>
              </div>
              {gear && (
                <div className="mt-3 space-y-2 text-sm">
                  <div><strong>Rod:</strong> {gear.rodAndLine}</div>
                  <div>
                    <strong>Lures/Baits:</strong>
                    <ul className="list-disc pl-5">
                      {gear.lures.map((l,i)=><li key={i}>{l}</li>)}
                    </ul>
                  </div>
                  <div>
                    <strong>Locations:</strong>
                    <ul className="list-disc pl-5">
                      {gear.locations.map((l,i)=><li key={i}>{l}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {bestTimes.length>0 && (
            <div className="mt-3 bg-slate-800 rounded p-3 text-sm">
              <div className="font-semibold mb-1">Best Times (today)</div>
              <ul className="list-disc pl-5">
                {bestTimes.map((b,i)=>(<li key={i}>{new Date(b.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · score {b.score}</li>))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="bg-slate-900 p-4 rounded-xl">
        <h2 className="font-semibold mb-2">Nearby Access</h2>
        <p className="text-xs text-slate-400">From OpenStreetMap via Overpass (free). Click to navigate.</p>
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          {pois.map(p=> (
            <a key={p.id} className="block bg-slate-800 rounded p-3 hover:bg-slate-700" href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`} target="_blank" rel="noreferrer">
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-xs text-slate-400">{p.type} · {p.lat.toFixed(4)}, {p.lon.toFixed(4)}</div>
            </a>
          ))}
        </div>
      </section>

      <footer className="text-xs text-slate-500 text-center py-6">
        v1.0 • Data: Open-Meteo, USGS, OpenStreetMap. Some values may be estimated when hydrology is unavailable.
      </footer>
    </div>
  )
}
