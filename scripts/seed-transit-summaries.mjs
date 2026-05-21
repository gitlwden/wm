#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'supply_chain:transit-summaries:v1';
const TTL = 28_800; // 8h — 2h buffer over 6h cron cadence
const PORTWATCH_KEY = 'supply_chain:portwatch:v1';
const BASELINES_KEY = 'energy:chokepoint-baselines:v1';
const FLOWS_KEY = 'energy:chokepoint-flows:v1';

// All 13 canonical chokepoint IDs (must match get-chokepoint-status.ts CHOKEPOINTS)
const CHOKEPOINT_IDS = [
  'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
  'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
  'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
];

// Baseline relay-id mapping (baselines use short IDs)
const BASELINE_MAP = {
  hormuz_strait: 'hormuz', malacca_strait: 'malacca', suez: 'suez',
  bab_el_mandeb: 'babelm', dover_strait: 'danish', bosphorus: 'turkish', panama: 'panama',
};

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.result) return null;
  const parsed = JSON.parse(data.result);
  return unwrapEnvelope(parsed).data;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export async function fetchAll() {
  const { url, token } = getRedisCredentials();
  const [portwatch, baselines, flows] = await Promise.all([
    redisGet(url, token, PORTWATCH_KEY),
    redisGet(url, token, BASELINES_KEY),
    redisGet(url, token, FLOWS_KEY).catch(() => null),
  ]);

  if (!portwatch || typeof portwatch !== 'object') {
    throw new Error('PortWatch data unavailable — cannot build transit summaries');
  }

  const summaries = {};
  let coveredCount = 0;

  for (const cpId of CHOKEPOINT_IDS) {
    const pw = portwatch[cpId];
    const baselineId = BASELINE_MAP[cpId];
    const baseline = baselines?.chokepoints?.find(b => b.id === baselineId);
    const flow = flows?.[cpId];

    // Build transit summary from portwatch history when available
    const history = pw?.history ? [...pw.history].sort((a, b) => a.date.localeCompare(b.date)) : [];

    // Compute vessel counts from last 7 days
    let todayTotal = 0, todayTanker = 0, todayCargo = 0, todayOther = 0;
    let wowChangePct = pw?.wowChangePct ?? 0;

    if (history.length >= 1) {
      const last = history[history.length - 1];
      todayTotal = last.total ?? 0;
      todayTanker = last.tanker ?? 0;
      todayCargo = last.cargo ?? 0;
      todayOther = last.other ?? 0;

      // Recompute wowChangePct from history (7d avg vs prior 7d)
      const last7 = history.slice(-7);
      const prev7 = history.slice(-14, -7);
      if (last7.length >= 3 && prev7.length >= 3) {
        const avgTotal = (day) => day.total ?? 0;
        const recent = avg(last7.map(avgTotal));
        const prior = avg(prev7.map(avgTotal));
        wowChangePct = prior > 0 ? Math.round(((recent - prior) / prior) * 1000) / 10 : 0;
      }
    }

    // Compute disruption / anomaly from 3-day trend
    const last3 = history.slice(-3);
    const prev90 = history.slice(-93, -3);
    const disrupted = last3.length === 3 && prev90.length >= 10 && last3.every(d => {
      const val = d.total ?? 0;
      const baselineAvg = avg(prev90.map(x => x.total ?? 0));
      return baselineAvg > 0 && (val / baselineAvg) < 0.85;
    });

    const dropPct = (() => {
      if (prev90.length < 10) return 0;
      const recent3Avg = avg(last3.map(d => d.total ?? 0));
      const baselineAvg = avg(prev90.map(d => d.total ?? 0));
      if (baselineAvg <= 0) return 0;
      return Math.round((1 - recent3Avg / baselineAvg) * 100);
    })();

    summaries[cpId] = {
      todayTotal,
      todayTanker,
      todayCargo,
      todayOther,
      wowChangePct,
      riskLevel: disrupted ? 'disrupted' : (flow?.hazardAlertLevel === 'RED' ? 'critical' : 'normal'),
      incidentCount7d: flow?.hazardAlertLevel ? 1 : 0,
      disruptionPct: disrupted ? dropPct : 0,
      riskSummary: flow?.hazardAlertName || baseline?.name || cpId,
      riskReportAction: disrupted ? 'Investigate disruption' : 'Monitor',
      anomaly: { dropPct, signal: disrupted },
      dataAvailable: history.length > 0,
    };

    if (history.length > 0) coveredCount++;
  }

  return {
    summaries,
    fetchedAt: Date.now(),
    _meta: { coveredCount, totalChokepoints: CHOKEPOINT_IDS.length },
  };
}

export function validateFn(data) {
  return data?.summaries && typeof data.summaries === 'object' && Object.keys(data.summaries).length >= 7;
}

const isMain = process.argv[1]?.endsWith('seed-transit-summaries.mjs');

if (isMain) {
  runSeed('supply_chain', 'transit-summaries', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'portwatch-derived-v1',
    recordCount: (data) => data?._meta?.coveredCount ?? Object.keys(data?.summaries ?? {}).length,
    schemaVersion: 1,
    maxStaleMin: 30,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.message || err.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
