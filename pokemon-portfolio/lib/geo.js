'use strict';
// Places for marketplace listings: turn what a seller typed ("Austin, TX", "90210", an address)
// into rough coordinates, and a device's coordinates back into a "City, State" label.
//
// Uses OpenStreetMap's free Nominatim service (one request per second, results cached), with
// Photon (also OpenStreetMap data) as a fallback. Coordinates are rounded to 2 decimals (about a
// kilometre) before they're stored, and never sent to other users — only distances are.

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io';
const UA = 'PokeFolio/1.0 (Pokémon card portfolio tracker; marketplace locations)';
const CACHE_MAX = 3000;
const TIMEOUT_MS = 8000;

const cache = new Map(); // key -> { value, at }
const remember = (k, value) => {
  cache.set(k, { value, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
};
const recall = (k) => {
  const hit = cache.get(k);
  // Misses (null) are retried after an hour; places themselves don't move.
  if (!hit || (hit.value == null && Date.now() - hit.at > 3600e3)) return undefined;
  return hit.value;
};

// Nominatim asks for at most one request per second: queue them.
let chain = Promise.resolve();
function politely(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en', Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`geocoder ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const round = (n) => Math.round(n * 100) / 100;
const validCoords = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};
// "Austin, TX" / "Leeds, England, United Kingdom" — a town-level label, never a street address.
function label({ city, state, country, countryCode }) {
  const us = (countryCode || '').toLowerCase() === 'us' || country === 'United States';
  const parts = [city, us ? (US_STATES[state] || state) : state, us ? null : country].filter(Boolean);
  return [...new Set(parts)].join(', ').slice(0, 80);
}
const fromNominatim = (a = {}) => label({
  city: a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county,
  state: a.state || a.region, country: a.country, countryCode: a.country_code,
});
const fromPhoton = (p = {}) => label({ city: p.city || p.town || p.village || p.district || p.county || p.name, state: p.state, country: p.country, countryCode: p.countrycode });

// Text → { lat, lon, label } or null.
async function geocode(text) {
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (q.length < 2) return null;
  const key = `f:${q.toLowerCase()}`;
  const hit = recall(key);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const rows = await politely(() => getJson(`${NOMINATIM}/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`));
    const r = Array.isArray(rows) && rows[0];
    if (r && validCoords(+r.lat, +r.lon)) out = { lat: round(+r.lat), lon: round(+r.lon), label: fromNominatim(r.address) || q };
  } catch { /* try the fallback */ }
  if (!out) {
    try {
      const j = await getJson(`${PHOTON}/api/?limit=1&q=${encodeURIComponent(q)}`);
      const f = j?.features?.[0];
      const [lon, lat] = f?.geometry?.coordinates || [];
      if (validCoords(+lat, +lon)) out = { lat: round(+lat), lon: round(+lon), label: fromPhoton(f.properties) || q };
    } catch { return null; } // both down: don't cache, try again next time
  }
  return remember(key, out);
}

// Coordinates → { lat, lon, label } (label is the town, not the street).
async function reverse(lat, lon) {
  if (!validCoords(lat, lon)) return null;
  const la = round(lat), lo = round(lon);
  const key = `r:${la},${lo}`;
  const hit = recall(key);
  if (hit !== undefined) return hit;
  let name = '';
  try {
    const r = await politely(() => getJson(`${NOMINATIM}/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${la}&lon=${lo}`));
    name = fromNominatim(r?.address);
  } catch {
    try {
      const j = await getJson(`${PHOTON}/reverse?lat=${la}&lon=${lo}`);
      name = fromPhoton(j?.features?.[0]?.properties);
    } catch { /* unnamed */ }
  }
  return remember(key, { lat: la, lon: lo, label: name || 'Near you' });
}

// Great-circle distance in miles.
function miles(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { geocode, reverse, miles, round, validCoords };
