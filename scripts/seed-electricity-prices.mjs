#!/usr/bin/env node

import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  withRetry,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const ELECTRICITY_KEY_PREFIX = 'energy:electricity:v1:';
export const ELECTRICITY_INDEX_KEY = 'energy:electricity:v1:index';
export const ELECTRICITY_META_KEY = 'seed-meta:energy:electricity-prices';
export const ELECTRICITY_TTL_SECONDS = 3 * 24 * 3600; // 3 days = 259200s

const LOCK_DOMAIN = 'energy:electricity-prices';
const LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_ENTSO_REGIONS = 7;

const ENTSO_E_REGIONS = [
  { region: 'DE', eic: '10Y1001A1001A82H', name: 'Germany' },       // DE-LU bidding zone (post-split)
  { region: 'FR', eic: '10YFR-RTE------C', name: 'France' },
  { region: 'ES', eic: '10YES-REE------0', name: 'Spain' },
  { region: 'IT', eic: '10Y1001A1001A73I', name: 'Italy (North)' }, // IT-North bidding zone
  { region: 'NL', eic: '10YNL----------L', name: 'Netherlands' },
  { region: 'BE', eic: '10YBE----------2', name: 'Belgium' },
  { region: 'PL', eic: '10YPL-AREA-----S', name: 'Poland' },
  { region: 'PT', eic: '10YPT-REN------W', name: 'Portugal' },
  { region: 'NO', eic: '10YNO-1--------2', name: 'Norway (Oslo)' }, // NO1 bidding zone
  { region: 'SE', eic: '10Y1001A1001A46L', name: 'Sweden (Stockholm)' }, // SE3 bidding zone
];

export const EIA_REGIONS = [
  { region: 'CISO',  respondent: 'CISO',  name: 'California' },
  { region: 'MISO',  respondent: 'MISO',  name: 'Midwest' },
  { region: 'PJM',   respondent: 'PJM',   name: 'Mid-Atlantic' },
  { region: 'NYISO', respondent: 'NYIS',  name: 'New York' },
  { region: 'ERCO',  respondent: 'ERCO',  name: 'Texas (ERCOT)' },
  { region: 'SPP',   respondent: 'SWPP',  name: 'Southwest' },
];

// ── Date helpers ─────────────────────────────────────────────────────────────

function formatEntsoDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}0000`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// ── XML parser (no external deps) ────────────────────────────────────────────

export function parseEntsoEPrice(xml) {
  const amounts = [];
  const re = /<price\.amount>(-?[\d.]+)<\/price\.amount>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) amounts.push(v);
  }
  if (amounts.length === 0) return null;
  return +(amounts.reduce((a, b) => a + b, 0) / amounts.length).toFixed(2);
}

// ── Index builder ─────────────────────────────────────────────────────────────

export function buildElectricityIndex(regionData, date) {
  const withPrices = regionData
    .filter((r) => r.priceMwhEur != null && Number.isFinite(r.priceMwhEur))
    .sort((a, b) => b.priceMwhEur - a.priceMwhEur)
    .slice(0, 20)
    .map((r) => ({ region: r.region, source: r.source, priceMwhEur: r.priceMwhEur }));

  return {
    updatedAt: new Date().toISOString(),
    date,
    regions: withPrices,
  };
}

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisPipeline(commands) {
  return cfPipeline(commands);
}