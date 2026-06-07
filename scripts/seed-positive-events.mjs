#!/usr/bin/env node

// Standalone seed script for positive events from GDELT geo API.
// Extracted from the relay's startPositiveEventsSeedLoop so GitHub Actions
// can run it independently of the long-lived WebSocket process.

import { loadEnvFile, getUpstashCredentials } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'positive-events:geo:v1';
const BOOTSTRAP_KEY = 'positive_events:geo-bootstrap:v1';
const META_KEY = 'seed-meta:positive-events:geo';
const TTL = 2700; // 45 min = 3× relay interval
const MAX_EVENTS = 500;

const QUERIES = [
  '(breakthrough OR discovery OR "renewable energy")',
  '(conservation OR "poverty decline" OR "humanitarian aid")',
  '("good news" OR volunteer OR donation OR charity)',
];

const INTER_QUERY_DELAY_MS = 5_500; // GDELT rate limit: 1 req / 5s

// Mirrors CATEGORY_KEYWORDS from src/services/positive-classifier.ts — keep in sync
const CATEGORY_KEYWORDS = [
  ['clinical trial', 'science-health'], ['study finds', 'science-health'],
  ['researchers', 'science-health'], ['scientists', 'science-health'],
  ['breakthrough', 'science-health'], ['discovery', 'science-health'],
  ['cure', 'science-health'], ['vaccine', 'science-health'],
  ['treatment', 'science-health'], ['medical', 'science-health'],
  ['endangered species', 'nature-wildlife'], ['conservation', 'nature-wildlife'],
  ['wildlife', 'nature-wildlife'], ['species', 'nature-wildlife'],
  ['marine', 'nature-wildlife'], ['forest', 'nature-wildlife'],
  ['renewable', 'climate-wins'], ['solar', 'climate-wins'],
  ['wind energy', 'climate-wins'], ['electric vehicle', 'climate-wins'],
  ['emissions', 'climate-wins'], ['carbon', 'climate-wins'],
  ['clean energy', 'climate-wins'], ['climate', 'climate-wins'],
  ['robot', 'innovation-tech'], ['technology', 'innovation-tech'],
  ['startup', 'innovation-tech'], ['innovation', 'innovation-tech'],
  ['artificial intelligence', 'innovation-tech'],
  ['volunteer', 'humanity-kindness'], ['donated', 'humanity-kindness'],
  ['charity', 'humanity-kindness'], ['rescued', 'humanity-kindness'],
  ['hero', 'humanity-kindness'], ['kindness', 'humanity-kindness'],
  [' art ', 'culture-community'], ['music', 'culture-community'],
  ['festival', 'culture-community'], ['education', 'culture-community'],
];

function classifyPositiveName(name) {
  const lower = ` ${name.toLowerCase()} `;
  for (const [kw, cat] of CATEGORY_KEYWORDS) {
    if (lower.includes(kw)) return cat;
  }
  return 'humanity-kindness';
}

async function redisSet(url, token, key, value, ttlSeconds) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]),
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

async function redisExpire(url, token, key, ttlSeconds) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['EXPIRE', key, String(ttlSeconds)]),
    signal: AbortSignal.timeout(5_000),
  });
  return resp.ok;
}

async function fetchGdeltGeoPositive(query) {
  const params = new URLSearchParams({ query, maxrows: '500' });
  const url = `https://api.gdeltproject.org/api/v1/gkg_geojson?${params}`;

  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`GDELT geo API returned HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const features = Array.isArray(data?.features) ? data.features : [];
  const locationMap = new Map();

  for (const f of features) {
    const name = String(f.properties?.name || '').substring(0, 200);
    if (!name) continue;
    if (name.startsWith('ERROR:') || name.includes('unknown error')) continue;

    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      locationMap.set(key, { latitude: lat, longitude: lon, name, count: 1 });
    }
  }

  const events = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 3) continue;
    events.push({
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.name,
      category: classifyPositiveName(loc.name),
      count: loc.count,
      timestamp: Date.now(),
    });
  }
  return events;
}

// ─── Main ──────────────────────────────────────────────────────────────

const { url: redisUrl, token: redisToken } = getUpstashCredentials();

console.log('=== Positive Events Seed ===');
console.log(`  Key:     ${CANONICAL_KEY}`);
console.log(`  Bootstrap: ${BOOTSTRAP_KEY}`);
console.log(`  TTL:     ${TTL}s`);

const t0 = Date.now();
const allEvents = [];
const seenNames = new Set();
let anyQuerySucceeded = false;

for (let i = 0; i < QUERIES.length; i++) {
  if (i > 0) {
    console.log(`  Waiting ${INTER_QUERY_DELAY_MS / 1000}s for GDELT rate limit...`);
    await new Promise((r) => setTimeout(r, INTER_QUERY_DELAY_MS));
  }

  const queryLabel = QUERIES[i].slice(0, 50);
  console.log(`  Fetching: ${queryLabel}...`);

  try {
    const events = await fetchGdeltGeoPositive(QUERIES[i]);
    anyQuerySucceeded = true;
    let newCount = 0;
    for (const e of events) {
      if (!seenNames.has(e.name)) {
        seenNames.add(e.name);
        allEvents.push(e);
        newCount++;
      }
    }
    console.log(`    ${events.length} locations, ${newCount} new`);
  } catch (err) {
    console.warn(`    Failed: ${err.message}`);
  }
}

if (!anyQuerySucceeded) {
  console.warn('  All GDELT queries failed — extending TTL on existing keys');
  try {
    await redisExpire(redisUrl, redisToken, CANONICAL_KEY, TTL);
    await redisExpire(redisUrl, redisToken, BOOTSTRAP_KEY, TTL);
  } catch {}
  console.log('  Done (failure — TTL extended)');
  process.exit(0);
}

const capped = allEvents.slice(0, MAX_EVENTS);
const payload = { events: capped, fetchedAt: Date.now() };

const envelope = buildEnvelope({
  fetchedAt: Date.now(),
  recordCount: capped.length,
  sourceVersion: 'positive-events',
  schemaVersion: 1,
  state: 'OK',
  data: payload,
});

console.log(`  Writing ${capped.length} events to Redis...`);

const ok1 = await redisSet(redisUrl, redisToken, CANONICAL_KEY, envelope, TTL);
const ok2 = await redisSet(redisUrl, redisToken, BOOTSTRAP_KEY, envelope, TTL);
const meta = { fetchedAt: Date.now(), recordCount: capped.length };
const ok3 = await redisSet(redisUrl, redisToken, META_KEY, meta, 604800); // 7d

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
if (ok1 && ok2 && ok3) {
  console.log(`  Seeded ${capped.length} events (redis: OK) in ${elapsed}s`);
} else {
  console.warn(`  Seeded ${capped.length} events (redis: PARTIAL — ok1=${ok1} ok2=${ok2} ok3=${ok3}) in ${elapsed}s`);
}

console.log('\n=== Done ===');
