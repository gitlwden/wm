#!/usr/bin/env node
// One-shot script: fetch global military facilities from OSM Overpass API
// and write scripts/data/osm-military-processed.json
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const OUT_PATH = join(DATA_DIR, 'osm-military-processed.json');

const QUERY = `
[out:json][timeout:600];
(
  node["military"~"base|barracks|airfield|naval_base|training_area|checkpoint|bunker|depot|range|installation|outpost"];
  way["military"~"base|barracks|airfield|naval_base|training_area|checkpoint|bunker|depot|range|installation|outpost"];
  relation["military"~"base|barracks|airfield|naval_base|training_area|checkpoint|bunker|depot|range|installation|outpost"];
);
out center;
`;

console.log('Querying Overpass API for global military facilities...');
const resp = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'worldmonitor/2.8.0 (https://github.com/gtlwd/wm)',
  },
  body: 'data=' + encodeURIComponent(QUERY),
  signal: AbortSignal.timeout(600_000),
});

if (!resp.ok) {
  console.error(`Overpass API returned HTTP ${resp.status}`);
  process.exit(1);
}

const data = await resp.json();
const elements = data.elements || [];
console.log(`Raw elements: ${elements.length}`);

const processed = elements
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
