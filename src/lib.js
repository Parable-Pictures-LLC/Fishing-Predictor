/* lib.js — utility + domain logic for Fishing Predictor
   All functions are pure and browser-safe. No external deps. */

// ---------------------------- Constants ----------------------------

export const ALL_GAME_FISH = [
  "Largemouth Bass","Smallmouth Bass","Striped Bass","White Bass",
  "Walleye","Sauger","Northern Pike","Muskellunge","Chain Pickerel",
  "Crappie","Bluegill","Sunfish","Yellow Perch","White Perch",
  "Channel Catfish","Flathead Catfish","Blue Catfish","Common Carp",
  "Rainbow Trout","Brown Trout","Brook Trout","Lake Trout","Cutthroat Trout",
  "Steelhead","Kokanee Salmon","Chinook Salmon","Coho Salmon","Sockeye Salmon",
  "Burbot","Whitefish","Grayling","Gar","Bowfin","Hybrid Striper"
];

// Lightweight “top 20” lists by water body type. These are broad, then refined in the app by temp.
export function top20ForType(type = "Water") {
  const t = String(type || "Water").toLowerCase();
  if (t.includes("river") || t.includes("stream")) {
    return [
      "Smallmouth Bass","Largemouth Bass","Walleye","Sauger","Northern Pike","Muskellunge",
      "Channel Catfish","Flathead Catfish","Blue Catfish","Crappie","Bluegill","Sunfish",
      "Common Carp","Rainbow Trout","Brown Trout","Brook Trout","Steelhead","Burbot",
      "Perch","White Bass"
    ];
  }
  // Lake / Reservoir / general
  return [
    "Largemouth Bass","Smallmouth Bass","Walleye","Northern Pike","Muskellunge","Striped Bass","White Bass",
    "Crappie","Bluegill","Sunfish","Yellow Perch","White Perch","Channel Catfish","Flathead Catfish","Blue Catfish",
    "Common Carp","Rainbow Trout","Brown Trout","Lake Trout","Kokanee Salmon"
  ];
}

// ---------------------------- Scoring ----------------------------

/** Basic preferences (°F) and style by species family to score success.
 *  Very simple heuristic: closer water temp to preference → higher score.
 */
const PREFS = {
  warm: { ideal: 68, low: 55, high: 82 }, // bass/panfish/catfish
  cool: { ideal: 62, low: 50, high: 75 }, // walleye/pike/muskie
  cold: { ideal: 54, low: 40, high: 62 }, // trout/salmon/grayling/whitefish
};

function bandForSpecies(species) {
  const s = String(species || "").toLowerCase();
  if (/(trout|salmon|grayling|whitefish|steelhead|kokanee|lake trout)/.test(s)) return "cold";
  if (/(walleye|sauger|pike|musk|pickerel)/.test(s)) return "cool";
  // default warm
  return "warm";
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function tempComponent(tempF, species) {
  if (!Number.isFinite(tempF)) return 45; // unknown → middling
  const band = PREFS[bandForSpecies(species)];
  const { ideal, low, high } = band;
  // triangular falloff around ideal
  const spread = (tempF <= ideal) ? (ideal - low) : (high - ideal);
  const d = Math.abs(tempF - ideal);
  const pct = clamp(1 - d / Math.max(8, spread), 0, 1); // 8°F minimum shoulder
  return 35 + pct * 50; // 35–85 points from temperature
}

function windComponent(windMph, waterType) {
  if (!Number.isFinite(windMph)) return 10;
  const t = String(waterType || "").toLowerCase();
  const sweet = t.includes("river") ? 3 : 6; // lighter wind for rivers
  const d = Math.abs((windMph || 0) - sweet);
  const pct = clamp(1 - d / 10, 0, 1);
  return pct * 10; // up to 10 pts
}

function cloudComponent(cloudPct, species) {
  if (!Number.isFinite(cloudPct)) return 5;
  const isTrout = bandForSpecies(species) === "cold";
  // trout like low light; warmwater can tolerate more sun if wind/chop exists.
  const target = isTrout ? 60 : 40;
  const d = Math.abs((cloudPct || 0) - target);
  const pct = clamp(1 - d / 50, 0, 1);
  return pct * 8; // up to 8 pts
}

function pressureComponent(inHg) {
  if (!Number.isFinite(inHg)) return 5;
  // steady/moderate pressure ~29.8–30.1 scores best; extremes lower
  const center = 29.95;
  const d = Math.abs(inHg - center);
  const pct = clamp(1 - d / 0.35, 0, 1);
  return pct * 7; // up to 7 pts
}

function turbidityComponent(fnu, species) {
  if (!Number.isFinite(fnu)) return 5;
  const isTrout = bandForSpecies(species) === "cold";
  // trout like clear: fnu < 10. warmwater can handle stain better
  const ideal = isTrout ? 5 : 15;
  const d = Math.abs((fnu || 0) - ideal);
  const pct = clamp(1 - d / (isTrout ? 10 : 25), 0, 1);
  return pct * 5; // up to 5 pts
}

/** successScore(species, waterType, derived)
 * derived = { waterTempF, windMph, cloudPct, barometerInHg, turbidityFnu }
 */
export function successScore(species, waterType, derived) {
  if (!species || !derived) return null;
  const t = tempComponent(derived.waterTempF, species);
  const w = windComponent(derived.windMph, waterType);
  const c = cloudComponent(derived.cloudPct, species);
  const p = pressureComponent(derived.barometerInHg);
  const u = turbidityComponent(derived.turbidityFnu, species);
  const raw = t + w + c + p + u; // ~0–115
  return Math.round(clamp(raw, 0, 100));
}

// ---------------------------- Gear ----------------------------

function arr(...xs) { return xs.filter(Boolean); }

function stdTackle(species, waterType, conditions) {
  const s = String(species || "").toLowerCase();
  const isRiver = String(waterType || "").toLowerCase().includes("river");
  const warm = bandForSpecies(species) === "warm";
  const cool = bandForSpecies(species) === "cool";
  const cold = bandForSpecies(species) === "cold";
  const stained = (conditions?.turbidityFnu ?? 0) > 15;

  // Rod & line
  let rodAndLine = "Medium spinning rod, 8–12 lb line";
  if (cold) rodAndLine = "Light/medium-light spinning rod, 4–8 lb line";
  if (cool) rodAndLine = "Medium or medium-heavy rod, 8–12 lb line";
  if (/musk|pike/.test(s)) rodAndLine = "Heavy rod, 30–60 lb braid + leader";

  // Lures
  let lures = [];
  if (warm) {
    lures = arr(
      stained ? "Spinnerbait (chartreuse)" : "Spinnerbait (white)",
      "Texas-rigged worm",
      "Jig & trailer",
      "Crankbait (squarebill in shallow cover)"
    );
  } else if (cool) {
    lures = arr(
      "Jerkbait (suspending)",
      stained ? "Vibrating blade bait" : "Swimbait (natural)",
      "Jig & minnow",
      isRiver ? "Bucktail inline spinner" : "Deep diving crank"
    );
  } else {
    // cold (trout/salmonids)
    lures = arr(
      "Inline spinner (gold/silver)",
      "Small spoon",
      "Minnow plug (natural)",
      isRiver ? "Egg pattern drift (float)" : null
    );
  }

  // Locations
  let locations = [];
  if (isRiver) {
    locations = ["Current breaks", "Eddy seams", "Deep pools", "Riffle tails at first/last light"];
  } else {
    locations = ["Points & windblown banks", "Weedlines", "Drop-offs", "Shallow flats (low light)"];
  }

  return { rodAndLine, lures, locations };
}

function flyRecs(species, waterType, conditions) {
  const s = String(species || "").toLowerCase();
  const isRiver = String(waterType || "").toLowerCase().includes("river");
  const band = bandForSpecies(species);
  const cold = band === "cold";
  const warm = band === "warm";
  const stained = (conditions?.turbidityFnu ?? 0) > 15;

  // Default fly tackle
  let flySetup = "5wt medium-fast, WF floating line, 9’ leader";
  if (/musk|pike/.test(s)) flySetup = "8–10wt, WF floating or intermediate, 6–9’ 30–60 lb bite leader";
  else if (/walleye|sauger/.test(s)) flySetup = "6–7wt, floating/sink-tip, 9’ leader";
  else if (cold) flySetup = "4–5wt, WF floating, 9–12’ leader";

  // Flies
  let flies = [];
  let flyPresentation = "";
  if (cold) {
    flies = arr(
      "Woolly Bugger (olive/black)",
      "Pheasant Tail Nymph",
      "Hare’s Ear Nymph",
      "Elk Hair Caddis",
      "Adams Parachute"
    );
    flyPresentation = isRiver
      ? "Dead-drift nymphs; swing buggers; dry flies at hatch or low light"
      : "Slow hand-twist retrieves near drop-offs; wind lanes at dawn/dusk";
  } else if (warm) {
    flies = arr(
      stained ? "Foam Popper (bright)" : "Foam Popper (natural)",
      "Clouser Minnow",
      "Crayfish (tan/olive)",
      "Deceiver",
      "Game Changer"
    );
    flyPresentation = isRiver
      ? "Popper over seams; strip streamers across current; target wood/rock"
      : "Popper over weed edges; strip-baitfish over points and flats";
  } else {
    // cool: pike/muskie/walleye
    flies = arr(
      "Large Deceiver",
      "Bunny Leech",
      stained ? "Flashabou Pike Fly (bright)" : "Flashabou Pike Fly (natural)",
      "Clouser Minnow (heavy eyes)"
    );
    flyPresentation = isRiver
      ? "Big streamers across current breaks; pace retrieves; rest in eddies"
      : "Count-down streamers along breaks; steady strip with pauses";
  }

  return { flies, flySetup, flyPresentation };
}

/** suggestGear(species, waterType, conditions)
 * returns:
 * { rodAndLine, lures[], flies[], flySetup, flyPresentation, locations[] }
 */
export function suggestGear(species, waterType, conditions) {
  const spin = stdTackle(species, waterType, conditions);
  const fly = flyRecs(species, waterType, conditions);
  return { ...spin, ...fly };
}

// ------------------------ Spatial / Math -------------------------

export function bboxFromCenterRadius(lat, lon, radiusMiles) {
  const R = 3958.8; // earth radius miles
  const rad = radiusMiles / R;
  const latRad = (lat * Math.PI) / 180;
  const dLat = rad * (180 / Math.PI);
  const dLon = (rad * (180 / Math.PI)) / Math.cos(latRad);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon
  };
}

export function haversineMiles(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------- Cache ------------------------------

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`fp:${key}`);
    if (!raw) return null;
    const { v, exp } = JSON.parse(raw);
    if (exp && Date.now() > exp) {
      localStorage.removeItem(`fp:${key}`);
      return null;
    }
    return v;
  } catch { return null; }
}

export function cacheSet(key, value, ttlMs) {
  try {
    const exp = ttlMs ? Date.now() + ttlMs : null;
    localStorage.setItem(`fp:${key}`, JSON.stringify({ v: value, exp }));
  } catch { /* ignore quota */ }
}

// ------------------------ Best Time Windows ----------------------

/** Simple feeding window estimator using dawn/dusk + low wind */
export function bestWindows({ sunriseTs, sunsetTs, hourly }) {
  if (!hourly || hourly.length === 0) return [];
  const scoreHour = (h) => {
    const wind = h.windMph ?? 5;
    const cloud = h.cloudPct ?? 50;
    let s = 0;
    if (wind <= 10) s += 10 - Math.abs(wind - 6); // best near 6 mph
    s += (cloud >= 30 && cloud <= 80) ? 5 : 2;
    // bonus near sunrise/sunset if times available
    const t = new Date(h.time).getTime();
    if (sunriseTs && Math.abs(t - sunriseTs) <= 90 * 60 * 1000) s += 8;
    if (sunsetTs && Math.abs(t - sunsetTs) <= 90 * 60 * 1000) s += 8;
    return Math.round(Math.max(0, Math.min(100, s)));
  };
  return hourly.slice(0, 24).map(h => ({ time: h.time, score: scoreHour(h) }))
    .filter(x => x.score >= 10)
    .sort((a,b)=>b.score - a.score)
    .slice(0, 6);
}
