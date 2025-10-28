// Utility and domain logic (species preferences, scoring, formatting, caching)

export const ALL_GAME_FISH = [
  'Largemouth Bass','Smallmouth Bass','Walleye','Northern Pike','Muskellunge','Rainbow Trout','Brown Trout','Brook Trout','Channel Catfish','Blue Catfish','Flathead Catfish','Crappie','Bluegill','Yellow Perch','Striped Bass','White Bass','Sauger','Carp','Hybrid Striper','Lake Trout'
];

export const SPECIES_PREFS = {
  'Largemouth Bass': { wt:[65,80], w:[3,12], c:[20,80], flow:false },
  'Smallmouth Bass': { wt:[58,72], w:[2,15], c:[20,80], flow:true },
  'Walleye': { wt:[45,68], w:[5,18], c:[40,100], flow:true },
  'Northern Pike': { wt:[50,68], w:[0,12], c:[20,80], flow:true },
  'Muskellunge': { wt:[55,72], w:[3,15], c:[30,90], flow:true },
  'Rainbow Trout': { wt:[45,60], w:[0,12], c:[10,70], flow:true },
  'Brown Trout': { wt:[45,62], w:[0,12], c:[10,70], flow:true },
  'Brook Trout': { wt:[45,58], w:[0,10], c:[10,70], flow:true },
  'Channel Catfish': { wt:[70,85], w:[0,15], c:[0,80], flow:false },
  'Blue Catfish': { wt:[65,80], w:[0,15], c:[0,80], flow:true },
  'Flathead Catfish': { wt:[70,85], w:[0,12], c:[0,80], flow:true },
  'Crappie': { wt:[55,72], w:[0,10], c:[20,80], flow:false },
  'Bluegill': { wt:[65,80], w:[0,10], c:[10,80], flow:false },
  'Yellow Perch': { wt:[50,68], w:[0,12], c:[10,80], flow:false },
  'Striped Bass': { wt:[55,70], w:[5,20], c:[20,80], flow:true },
  'White Bass': { wt:[55,72], w:[5,20], c:[20,80], flow:true },
  'Sauger': { wt:[42,62], w:[0,15], c:[40,100], flow:true },
  'Carp': { wt:[65,85], w:[0,12], c:[0,100], flow:false },
  'Hybrid Striper': { wt:[55,72], w:[5,20], c:[20,80], flow:true },
  'Lake Trout': { wt:[40,55], w:[0,15], c:[20,80], flow:false }
};

export function within(x,[lo,hi]) { const mid=(lo+hi)/2, half=(hi-lo)/2; return Math.max(0, Math.min(100, (1 - Math.abs((x-mid)/half)) * 100)); }
export function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi,n)); }

export function successScore(species, waterType, c) {
  const pref = SPECIES_PREFS[species] || { wt:[55,72], w:[0,15], c:[0,100], flow:false };
  const t = within(c.waterTempF, pref.wt);
  const wind = within(c.windMph, pref.w);
  const cloud = within(c.cloudPct, pref.c);
  const pressureAdj = c.barometerInHg < 29.6 ? 8 : c.barometerInHg > 30.2 ? -6 : 0;
  const flowAdj = (waterType==='River' || waterType==='Stream') ? (pref.flow?10:-5) : 0;
  const base = 0.45*t + 0.25*wind + 0.2*cloud + 10 + pressureAdj + flowAdj;
  return Math.round(clamp(base,0,100));
}

export function suggestGear(species, waterType, c){
  const cold=c.waterTempF<55, warm=c.waterTempF>70, windy=c.windMph>12, stained=(c.turbidityFnu??0)>8;
  let rod = 'Medium spinning, 8–12 lb';
  if(['Crappie','Bluegill','Yellow Perch'].includes(species)) rod='Ultralight spinning, 4–6 lb mono';
  else if(['Largemouth Bass','Smallmouth Bass','White Bass','Hybrid Striper'].includes(species)) rod='Medium spin/cast, 10–15 lb braid + fluoro';
  else if(['Walleye','Sauger'].includes(species)) rod='Medium-light spinning, 8–10 lb';
  else if(['Northern Pike','Muskellunge'].includes(species)) rod='Heavy casting, 50–80 lb braid + steel leader';
  else if(species.includes('Catfish')) rod='Medium-heavy, 20–30 lb mono';
  else if(species.includes('Trout')) rod='Light spinning or 4–5 wt fly';
  const l=[];
  if(['Largemouth Bass','Smallmouth Bass'].includes(species)){
    if(cold) l.push('Jigs + trailers','Suspending jerkbaits');
    if(!cold&&!warm) l.push('3–4" swimbaits','Spinnerbaits','Squarebills');
    if(warm) l.push('Topwater (low light)','Texas-rig worms');
  } else if(['Walleye','Sauger'].includes(species)) l.push('Jig + minnow','Live-bait rig','Deep crankbaits');
  else if(['Crappie','Bluegill','Yellow Perch'].includes(species)) l.push('1/32–1/16 oz jigs','Waxworms/minnows','Floats');
  else if(['Northern Pike','Muskellunge'].includes(species)) l.push('Inline spinners','Glide baits','Bucktails','Large swimbaits');
  else if(species.includes('Trout')) l.push('Spinners (1–3)','Spoons','Nymphs/streamers');
  else if(species.includes('Catfish')) l.push('Cut bait','Stink bait','Live bait (legal)');
  else if(['Striped Bass','White Bass','Hybrid Striper'].includes(species)) l.push('Jigging spoons','Topwater walkers','Paddle-tail swimbaits');
  else l.push('Ned rig','Spinnerbait','Small swimbaits');
  if(stained) l.push('Add rattles/vibration','Chartreuse/black');
  if(windy) l.push('Heavier heads 3/8–1/2 oz','Fast-moving search baits');
  const loc=[];
  if(waterType==='Lake'||waterType==='Reservoir') loc.push(cold?'Deep points/channels':warm?'Weedlines, docks, shade':'Mid-depth structure, rock');
  else loc.push('Current seams, eddies, behind boulders');
  return { rodAndLine:rod, lures:l, locations:loc };
}

export const speciesByType = {
  Lake: ['Largemouth Bass','Crappie','Bluegill','Walleye','Northern Pike','Yellow Perch','Muskellunge','Channel Catfish','Hybrid Striper','Lake Trout'],
  River: ['Smallmouth Bass','Walleye','Sauger','Channel Catfish','Flathead Catfish','Carp','Striped Bass','White Bass','Brown Trout','Rainbow Trout'],
  Stream: ['Brook Trout','Brown Trout','Rainbow Trout','Smallmouth Bass','Carp','Bluegill','Crappie','Yellow Perch','Channel Catfish','Walleye'],
  Reservoir: ['Largemouth Bass','Hybrid Striper','White Bass','Crappie','Bluegill','Walleye','Channel Catfish','Sauger','Northern Pike','Muskellunge']
};

export function top20ForType(type){
  const base = speciesByType[type] || [];
  const extras = ALL_GAME_FISH.filter(s=>!base.includes(s));
  return [...base, ...extras].slice(0,20);
}

export function milesToMeters(mi){ return mi * 1609.344 }
export function metersToMiles(m){ return m / 1609.344 }
export function haversineMiles(a,b){
  const R=6371e3, toRad=d=>d*Math.PI/180; const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return metersToMiles(2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s)));
}

export function bboxFromCenterRadius(lat,lon,mi){
  const dLat = mi/69; // ~69 miles per deg lat
  const dLon = mi/(69*Math.cos(lat*Math.PI/180));
  return { minLon: lon-dLon, minLat: lat-dLat, maxLon: lon+dLon, maxLat: lat+dLat };
}

// Simple localStorage cache with TTL
export function cacheGet(key){
  try{ const raw=localStorage.getItem(key); if(!raw) return null; const {exp,val}=JSON.parse(raw); if(Date.now()>exp) return null; return val; }catch{return null}
}
export function cacheSet(key,val,ttlMs){ localStorage.setItem(key, JSON.stringify({exp:Date.now()+ttlMs,val})) }

export function fmt(n, unit=''){ return `${n}${unit}` }

// Best-time-of-day heuristic
export function bestWindows({sunriseTs, sunsetTs, hourly}){
  const windows=[];
  const near = (ts, target, h)=> Math.abs(ts-target) <= h*3600*1000;
  hourly.forEach(h=>{
    const ts = new Date(h.time).getTime();
    let score = 0;
    if(sunriseTs && near(ts, sunriseTs, 2)) score += 30;
    if(sunsetTs && near(ts, sunsetTs, 2)) score += 30;
    score += (100 - Math.min(100, (h.windMph||0)*4));
    score += (100 - (h.cloudPct||0));
    windows.push({ time:h.time, score: Math.round(score/3) });
  });
  return windows.sort((a,b)=>b.score-a.score).slice(0,4);
}
