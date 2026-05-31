#!/usr/bin/env node
import { getRedisCredentials, cfPipeline } from './_seed-utils.mjs';

import { resolveProxyStringConnect } from './_proxy-utils.cjs';
import {
  createCountryResolvers,
  isIso2,
  isIso3,
  normalizeCountryToken,
  resolveIso2,
} from './_country-resolver.mjs';
import { isInRankableUniverse } from './shared/rankable-universe.mjs';

export { createCountryResolvers, resolveIso2 } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
export const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';
export const RESILIENCE_STATIC_PREFIX = 'resilience:static:';
// Aggregated IPC Phase 3+ view — readers that want "which countries are in a
// food crisis this year" without fanning out to 222 per-country keys. Shape is
// compatible with scripts/backtest-resilience-outcomes.mjs::detectFoodCrisis:
// { countries: { ISO2: { ipcPhase, phase, peopleInCrisis, year } } }.
export const RESILIENCE_STATIC_FAO_KEY = 'resilience:static:fao';
export const RESILIENCE_STATIC_TTL_SECONDS = 400 * 24 * 60 * 60;
// Plan 2026-04-26-002 §U2 (PR 1) bumped v7 → v8 because this PR adds
// the rankable-universe filter at finalizeCountryPayloads. Without
// the version bump, `shouldSkipSeedYear` (line ~70) would no-op the
// post-merge seeder run since prod already has a successful 2026 v7
// seed — the new whitelist would never run, the static index would
// remain at ~222 entries, and the universe filter would silently
// not take effect. Caught by reviewer post-PR-3435 push.
export const RESILIENCE_STATIC_SOURCE_VERSION = 'resilience-static-v8';
export const RESILIENCE_STATIC_WINDOW_CRON = '0 */4 1-3 10 *';

const LOCK_DOMAIN = 'resilience:static';
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const TOTAL_DATASET_SLOTS = 11;
const COUNTRY_DATASET_FIELDS = ['wgi', 'infrastructure', 'gpi', 'rsf', 'who', 'fao', 'aquastat', 'iea', 'tradeToGdp', 'fxReservesMonths', 'appliedTariffRate'];
const WGI_INDICATORS = ['VA.EST', 'PV.EST', 'GE.EST', 'RQ.EST', 'RL.EST', 'CC.EST'];
const INFRASTRUCTURE_INDICATORS = ['EG.ELC.ACCS.ZS', 'IS.ROD.PAVE.ZS', 'EG.USE.ELEC.KH.PC', 'IT.NET.BBND.P2'];
const WHO_INDICATORS = {
  hospitalBeds: 'WHS6_102',
  uhcIndex: 'UHC_INDEX_REPORTED',
  // WHS4_100 from the issue body no longer resolves; WHO currently exposes MCV1 coverage on WHS8_110.
  measlesCoverage: process.env.RESILIENCE_WHO_MEASLES_INDICATOR || 'WHS8_110',
  physiciansPer10k: 'HWF_0001',
  healthExpPerCapitaUsd: 'GHED_CHE_pc_US_SHA2011',
};
const WORLD_BANK_BASE = 'https://api.worldbank.org/v2';
const WHO_BASE = 'https://ghoapi.azureedge.net/api';
const RSF_RANKING_URL = 'https://rsf.org/en/ranking';
const EUROSTAT_ENERGY_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ind_id?freq=A';
const WB_ENERGY_IMPORT_INDICATOR = 'EG.IMP.CONS.ZS';
const COUNTRY_RESOLVERS = createCountryResolvers();

export function countryRedisKey(iso2) {
  return `${RESILIENCE_STATIC_PREFIX}${iso2}`;
}

function nowSeedYear(now = new Date()) {
  return now.getUTCFullYear();
}

export function shouldSkipSeedYear(meta, seedYear = nowSeedYear()) {
  return Boolean(
    meta
    && meta.status === 'ok'
    && meta.sourceVersion === RESILIENCE_STATIC_SOURCE_VERSION
    && Number(meta.seedYear) === seedYear
    && !(meta.failedDatasets?.length > 0)
    && Number.isFinite(Number(meta.recordCount))
    && Number(meta.recordCount) > 0,
  );
}

function safeNum(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function coalesceYear(...values) {
  const numeric = values.map(v => safeNum(v)).filter(v => v != null);
  return numeric.length ? Math.max(...numeric) : null;
}

function roundMetric(value, digits = 3) {
  const numeric = safeNum(value);
  if (numeric == null) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

async function redisPipeline(commands) {
  return cfPipeline(commands);
}

async function fetchTextDirect(url, accept, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    throw err;
  }
  return { text: await response.text(), contentType: response.headers.get('content-type') || '' };
}

export async function main() {
  const startedAt = Date.now();
  const runId = `resilience-static:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('  resilience-static: another seed run is already active');
    return;
  }

  try {
    const result = await seedResilienceStatic();
    logSeedResult('resilience:static', result?.manifest?.recordCount ?? 0, Date.now() - startedAt, {
      skipped: Boolean(result?.skipped),
      seedYear: result?.seedYear ?? result?.manifest?.seedYear ?? nowSeedYear(),
      failedDatasets: result?.manifest?.failedDatasets ?? [],
    });
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-static.mjs')) {
  main().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
    console.error(`FATAL: ${error.message || error}${cause}`);
    process.exit(1);
  });
}