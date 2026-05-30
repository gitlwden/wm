#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:pizzint:seed:v1';
const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';
const TTL = 1800; // 30 min

export function declareRecords(data) {
  return data?.pizzint?.locationsMonitored ?? 0;
}

async function fetchPizzint() {
  const resp = await fetch(PIZZINT_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`pizzint.watch HTTP ${resp.status}`);
  const raw = await resp.json();
  if (!raw.success || !Array.isArray(raw.data)) throw new Error('No data in pizzint API response');

  const locations = raw.data.map((d) => ({
    placeId: d.place_id || '',
    name: d.name || '',
    address: d.address || '',
    currentPopularity: typeof d.current_popularity === 'number' ? d.current_popularity : 0,
    percentageOfUsual: typeof d.percentage_of_usual === 'number' ? d.percentage_of_usual : 0,
    isSpike: !!d.is_spike,
    spikeMagnitude: typeof d.spike_magnitude === 'number' ? d.spike_magnitude : 0,
    dataSource: d.data_source || '',
    recordedAt: d.recorded_at || '',
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: !!d.is_closed_now,
    lat: d.lat ?? 0,
    lng: d.lng ?? 0,
  }));

  const openLocations = locations.filter((l) => !l.isClosedNow);
  const activeSpikes = locations.filter((l) => l.isSpike).length;
  const avgPop = openLocations.length > 0
    ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
    : 0;

  let adjusted = avgPop + (activeSpikes > 0 ? activeSpikes * 10 : 0);
  adjusted = Math.min(100, adjusted);
  let defconLevel = 5;
  let defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

  const pizzint = {
    defconLevel, defconLabel,
    aggregateActivity: Math.round(avgPop),
    activeSpikes,
    locationsMonitored: locations.length,
    locationsOpen: openLocations.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };

  // GDELT tensions (non-fatal)
  let tensionPairs = [];
  try {
    const gdeltUrl = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
    const gdeltResp = await fetch(gdeltUrl, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (gdeltResp.ok) {
      const gdeltRaw = await gdeltResp.json();
      tensionPairs = Object.entries(gdeltRaw).map(([pairKey, dataPoints]) => {
        const countries = pairKey.split('_');
        const latest = dataPoints[dataPoints.length - 1];
        const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
        const change = prev && prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
        const trend = change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE';
        return {
          id: pairKey, countries,
          label: countries.map((c) => c.toUpperCase()).join(' - '),
          score: latest?.v ?? 0, trend,
          changePercent: Math.round(change * 10) / 10,
          region: 'global',
        };
      });
    }
  } catch { /* non-fatal */ }

  return { pizzint, tensionPairs };
}

await runSeed('intelligence', 'pizzint', CANONICAL_KEY, fetchPizzint, {
  ttlSeconds: TTL,
  sourceVersion: 'pizzint-watch-v1',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 60,
}).catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
