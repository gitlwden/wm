#!/usr/bin/env node
// One-shot script: fetch global military facilities from OSM Overpass API
// Split into regional queries to avoid 504 timeouts.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const OUT_PATH = join(DATA_DIR, 'osm-military-processed.json');

const MILITARY_TYPES = 'base|barracks|airfield|naval_base|training_area|checkpoint|bunker|depot|range|installation|outpost';

// Regional bounding boxes [south, west, north, east]
const REGIONS = [
  { name: 'Europe',        bbox: '35,-25,72,50' },
  { name: 'Russia/Central', bbox: '40,50,80,180' },
  { name: 'Middle East',   bbox: '12,25,42,65' },
  { name: 'Africa',        bbox: '-35,-20,38,55' },
  { name: 'South Asia',    bbox: '5,60,38,100' },
  { name: 'East Asia',     bbox: '-10,100,55,150' },
  { name: 'SE Asia',       bbox: '-12,95,25,145' },
  { name: 'North America', bbox: '15,-170,75,-50' },
  { name: 'South America', bbox: '-56,-82,15,-34' },
  { name: 'Oceania',       bbox: '-50,110,0,180' },
];

async function queryRegion(region) {
  const query = `
[out:json][timeout:180];
(
  node["military"~"${MILITARY_TYPES}"](${region.bbox});
  way["military"~"${MILITARY_TYPES}"](${region.bbox});
  relation["military"~"${MILITARY_TYPES}"](${region.bbox});
);
out center;
`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'worldmonitor/2.8.0 (https://github.com/jlulwd/wm)',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(200_000),
  });

  if (!resp.ok) {
    console.warn(`  ${region.name}: HTTP ${resp.status} — skipping`);
    return [];
  }

  const data = await resp.json();
  return data.elements || [];
}

const allElements = [];
const seen = new Set();

for (const region of REGIONS) {
  console.log(`Querying ${region.name}...`);
  try {
    const elements = await queryRegion(region);
    let added = 0;
    for (const el of elements) {
      const key = `${el.type}/${el.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        allElements.push(el);
        added++;
      }
    }
    console.log(`  ${region.name}: ${elements.length} raw, ${added} new (total: ${allElements.length})`);
  } catch (err) {
    console.warn(`  ${region.name}: ${err.message} — skipping`);
  }
  // Rate limit: 2s between queries
  await new Promise(r => setTimeout(r, 2000));
}

console.log(`\nTotal unique elements: ${allElements.length}`);

const processed = allElements
  .map(el => ({
    osm_id: `${el.type}/${el.id}`,
    name: el.tags?.name || '',
    lat: el.lat || el.center?.lat || null,
    lon: el.lon || el.center?.lon || null,
    military: el.tags?.military || '',
    country: el.tags?.['addr:country'] || '',
    wikipedia: el.tags?.wikipedia || '',
    wikidata: el.tags?.wikidata || '',
    source: 'osm',
  }))
  .filter(e => e.lat != null && e.lon != null);

console.log(`Processed entries with coordinates: ${processed.length}`);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(processed));
console.log(`Written to ${OUT_PATH}`);
