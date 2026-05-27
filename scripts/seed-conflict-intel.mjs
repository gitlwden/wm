#!/usr/bin/env node

/**
 * Seed conflict + intelligence data to Redis.
 *
 * Seedable (fixed/predictable inputs):
 * - GDELT conflict events (all countries, last 30 days)
 * - getHumanitarianSummary (top conflict countries)
 * - getPizzintStatus (base + gdelt variants)
 *
 * NOT seeded (inherently on-demand, user-specific):
 * - classifyEvent: per-headline LLM classification (sha256 cache key)
 * - deductSituation: per-query LLM deduction
 * - getCountryIntelBrief: per-country LLM brief with context hash
 * - getCountryFacts: per-country REST Countries + Wikidata + Wikipedia
 * - searchGdeltDocuments: per-query GDELT search
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep, loadSharedConfig } from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';

loadEnvFile(import.meta.url);

const GDELT_CACHE_KEY = 'conflict:gdelt:v1:all:0:0';
const GDELT_CII_KEY = 'conflict:gdelt:v1:cii';
const GDELT_TTL = 900;
const HAPI_CACHE_KEY_PREFIX = 'conflict:humanitarian:v1';
const HAPI_TTL = 21600;
const PIZZINT_TTL = 600;

const CONFLICT_COUNTRIES = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];

const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');

// ─── GDELT Conflict Events ───

/** Map GDELT location name to an event type. */
function classifyEventType(name) {
  const lower = name.toLowerCase();
  if (lower.includes('bomb') || lower.includes('explos') || lower.includes('shell') || lower.includes('airstrik') || lower.includes('missil'))
    return 'Explosions/Remote violence';
  if (lower.includes('battle') || lower.includes('clash') || lower.includes('offensiv') || lower.includes('siege'))
    return 'Battles';
  if (lower.includes('attack') || lower.includes('kill') || lower.includes('massacr') || lower.includes('violence'))
    return 'Violence against civilians';
  return 'Battles';
}

/** Map event type to CII category. */
function toCiiCategory(eventType) {
  const lower = eventType.toLowerCase();
  if (lower.includes('explosion') || lower.includes('remote')) return { type: 'Explosions/Remote violence', bucket: 'explosions' };
  if (lower.includes('battle')) return { type: 'Battles', bucket: 'battles' };
  if (lower.includes('violence')) return { type: 'Violence against civilians', bucket: 'civilianViolence' };
  return { type: 'Battles', bucket: 'battles' };
}

function extractCountry(name) {
  const parts = name.split(',').map(p => p.trim());
  return parts[parts.length - 1] || name;
}

function extractAdmin1(name) {
  const parts = name.split(',').map(p => p.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

async function fetchGdeltConflictEvents() {
  const params = new URLSearchParams({
    query: 'battle OR explosion OR airstrike OR "violence against" OR shelling OR offensive',
    maxrows: '2500',
  });
  const url = `https://api.gdeltproject.org/api/v1/gkg_geojson?${params}`;

  let data;
  try {
    data = await fetchGdeltJson(url, { label: 'conflict-events', timeoutMs: 20_000, proxyMaxAttempts: 5 });
  } catch (err) {
    console.warn(`  GDELT conflict fetch failed: ${err.message}`);
    return null;
  }

  const features = data?.features || [];
  const now = Date.now();

  // Aggregate by location cell (0.1° grid)
  const cellMap = new Map();
  for (const f of features) {
    const name = f.properties?.name || '';
    if (!name) continue;

    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const key = `${Math.round(lat * 10)}:${Math.round(lon * 10)}`;
    const existing = cellMap.get(key);
    if (existing) {
      existing.count++;
      const tone = f.properties?.urltone ?? 0;
      if (tone < existing.worstTone) existing.worstTone = tone;
    } else {
      cellMap.set(key, { name, lat, lon, count: 1, worstTone: f.properties?.urltone ?? 0 });
    }
  }

  // Build events for RPC handler
  const events = [];
  // Build per-country CII rows for risk scoring
  const ciiCountryCounts = new Map(); // country -> { events: N, buckets: {battles, explosions, civilianViolence} }

  for (const [, cell] of cellMap) {
    if (cell.count < 3) continue;

    const eventType = classifyEventType(cell.name);
    const country = extractCountry(cell.name);

    events.push({
      id: `gdelt-${cell.lat.toFixed(2)}-${cell.lon.toFixed(2)}`,
      eventType,
      country,
      location: { latitude: cell.lat, longitude: cell.lon },
      occurredAt: now,
      fatalities: 0,
      actors: [],
      source: 'GDELT',
      admin1: extractAdmin1(cell.name),
    });

    // Accumulate CII counts per country
    const { bucket } = toCiiCategory(eventType);
    let agg = ciiCountryCounts.get(country);
    if (!agg) { agg = { total: 0, battles: 0, explosions: 0, civilianViolence: 0 }; ciiCountryCounts.set(country, agg); }
    agg.total += cell.count;
    agg[bucket] = (agg[bucket] || 0) + cell.count;
  }

  // Build CII event rows — one per country bucket, proportional to count
  const ciiEvents = [];
  for (const [country, agg] of ciiCountryCounts) {
    if (agg.battles > 0) ciiEvents.push({ country, event_type: 'Battles', fatalities: 0, daysAgo: 0 });
    if (agg.explosions > 0) ciiEvents.push({ country, event_type: 'Explosions/Remote violence', fatalities: 0, daysAgo: 0 });
    if (agg.civilianViolence > 0) ciiEvents.push({ country, event_type: 'Violence against civilians', fatalities: 0, daysAgo: 0 });
  }

  console.log(`  GDELT: ${features.length} mentions → ${events.length} conflict events, ${ciiEvents.length} CII rows`);
  return { events, ciiEvents, pagination: undefined };
}

// ─── Humanitarian Summary (HAPI) ───

async function fetchHapiSummary(countryCode) {
  const iso3 = ISO2_TO_ISO3[countryCode];
  if (!iso3) return null;

  const appId = Buffer.from('worldmonitor:monitor@worldmonitor.app').toString('base64');
  const url = `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}&location_code=${iso3}`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const rawData = await resp.json();
  const records = rawData.data || [];

  const agg = { eventsTotal: 0, eventsPV: 0, eventsCT: 0, eventsDem: 0, fatPV: 0, fatCT: 0, month: '', locationName: '' };
  for (const r of records) {
    if ((r.location_code || '') !== iso3) continue;
    const month = r.reference_period_start || '';
    const eventType = (r.event_type || '').toLowerCase();
    const events = r.events || 0;
    const fatalities = r.fatalities || 0;
    if (!agg.locationName) agg.locationName = r.location_name || '';
    if (month > agg.month) { agg.month = month; agg.eventsTotal = 0; agg.eventsPV = 0; agg.eventsCT = 0; agg.eventsDem = 0; agg.fatPV = 0; agg.fatCT = 0; }
    if (month === agg.month) {
      agg.eventsTotal += events;
      if (eventType.includes('political_violence')) { agg.eventsPV += events; agg.fatPV += fatalities; }
      if (eventType.includes('civilian_targeting')) { agg.eventsCT += events; agg.fatCT += fatalities; }
      if (eventType.includes('demonstration')) agg.eventsDem += events;
    }
  }
  if (!agg.month) return null;

  return {
    summary: {
      countryCode: countryCode.toUpperCase(),
      countryName: agg.locationName,
      conflictEventsTotal: agg.eventsTotal,
      conflictPoliticalViolenceEvents: agg.eventsPV + agg.eventsCT,
      conflictFatalities: agg.fatPV + agg.fatCT,
      referencePeriod: agg.month,
      conflictDemonstrations: agg.eventsDem,
      updatedAt: Date.now(),
    },
  };
}

async function fetchAllHumanitarianSummaries() {
  const results = {};
  for (const cc of CONFLICT_COUNTRIES) {
    try {
      const data = await fetchHapiSummary(cc);
      if (data?.summary) results[cc] = data;
      await sleep(300);
    } catch (e) {
      console.warn(`  HAPI ${cc}: ${e.message}`);
    }
  }
  console.log(`  Humanitarian: ${Object.keys(results).length}/${CONFLICT_COUNTRIES.length} countries`);
  return results;
}

// ─── PizzINT Status ───

async function fetchPizzintStatus() {
  const resp = await fetch('https://www.pizzint.watch/api/dashboard-data', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const raw = await resp.json();
  if (!raw.success || !raw.data) return null;

  const locations = raw.data.map(d => ({
    placeId: d.place_id, name: d.name, address: d.address,
    currentPopularity: d.current_popularity,
    percentageOfUsual: d.percentage_of_usual ?? 0,
    isSpike: d.is_spike, spikeMagnitude: d.spike_magnitude ?? 0,
    dataSource: d.data_source, recordedAt: d.recorded_at,
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: d.is_closed_now ?? false, lat: d.lat ?? 0, lng: d.lng ?? 0,
  }));

  const open = locations.filter(l => !l.isClosedNow);
  const spikes = locations.filter(l => l.isSpike).length;
  const avgPop = open.length > 0 ? open.reduce((s, l) => s + l.currentPopularity, 0) / open.length : 0;
  const adjusted = Math.min(100, avgPop + spikes * 10);
  let defconLevel = 5, defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some(l => l.dataFreshness === 'DATA_FRESHNESS_FRESH');
  const pizzint = {
    defconLevel, defconLabel, aggregateActivity: Math.round(avgPop),
    activeSpikes: spikes, locationsMonitored: locations.length, locationsOpen: open.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };

  console.log(`  PizzINT: DEFCON ${defconLevel}, ${locations.length} locations, ${spikes} spikes`);
  return pizzint;
}

async function fetchGdeltTensions() {
  const pairs = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';
  const resp = await fetch(`https://www.pizzint.watch/api/gdelt/batch?pairs=${encodeURIComponent(pairs)}&method=gpr`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const raw = await resp.json();
  return Object.entries(raw).map(([pairKey, dataPoints]) => {
    const countries = pairKey.split('_');
    const latest = dataPoints[dataPoints.length - 1];
    const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
    const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
    return {
      id: pairKey, countries, label: countries.map(c => c.toUpperCase()).join(' - '),
      score: latest?.v ?? 0,
      trend: change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE',
      changePercent: Math.round(change * 10) / 10, region: 'global',
    };
  });
}

// ─── Main ───

async function fetchAll() {
  const [gdelt, hapi, pizzint, tensions] = await Promise.allSettled([
    fetchGdeltConflictEvents(),
    fetchAllHumanitarianSummaries(),
    fetchPizzintStatus(),
    fetchGdeltTensions(),
  ]);

  const gd = gdelt.status === 'fulfilled' ? gdelt.value : null;
  const ha = hapi.status === 'fulfilled' ? hapi.value : null;
  const pi = pizzint.status === 'fulfilled' ? pizzint.value : null;
  const tn = tensions.status === 'fulfilled' ? tensions.value : null;

  if (gdelt.status === 'rejected') console.warn(`  GDELT failed: ${gdelt.reason?.message || gdelt.reason}`);
  if (hapi.status === 'rejected') console.warn(`  HAPI failed: ${hapi.reason?.message || hapi.reason}`);
  if (pizzint.status === 'rejected') console.warn(`  PizzINT failed: ${pizzint.reason?.message || pizzint.reason}`);
  if (tensions.status === 'rejected') console.warn(`  GDELT tensions failed: ${tensions.reason?.message || tensions.reason}`);

  if (!gd && !ha && !pi) throw new Error('All conflict/intel fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (gd?.ciiEvents) await writeExtraKeyWithMeta(GDELT_CII_KEY, { events: gd.ciiEvents }, GDELT_TTL, gd.ciiEvents.length);
  if (ha) { for (const [cc, data] of Object.entries(ha)) await writeExtraKeyWithMeta(`${HAPI_CACHE_KEY_PREFIX}:${cc}`, data, HAPI_TTL, 1); }
  if (pi) await writeExtraKeyWithMeta('intel:pizzint:v1:base', { pizzint: pi, tensionPairs: [] }, PIZZINT_TTL, pi.locationsMonitored ?? 0);
  if (pi && tn) await writeExtraKeyWithMeta('intel:pizzint:v1:gdelt', { pizzint: pi, tensionPairs: tn }, PIZZINT_TTL, tn.length ?? 0);

  return gd ? { events: gd.events, pagination: gd.pagination } : { events: [], pagination: undefined };
}

function validate(data) {
  return data != null && Array.isArray(data.events);
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

runSeed('conflict', 'gdelt-intel', GDELT_CACHE_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: GDELT_TTL,
  sourceVersion: 'gdelt-hapi-pizzint',
  declareRecords,
  schemaVersion: 2,
  maxStaleMin: 38,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
