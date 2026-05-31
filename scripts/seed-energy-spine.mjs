#!/usr/bin/env node

import {
  acquireLockSafely,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

export const SPINE_KEY_PREFIX = 'energy:spine:v1:';
export const SPINE_COUNTRIES_KEY = 'energy:spine:v1:_countries';
export const SPINE_META_KEY = 'seed-meta:energy:spine';
export const SPINE_TTL_SECONDS = 172800; // 48h — 2× daily cron interval

const LOCK_DOMAIN = 'energy:spine';
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min (pipeline write of 200+ countries)
const MIN_COVERAGE_RATIO = 0.80; // abort if new spine < 80% of previous country count

// Countries with Comtrade reporter codes for shock model inputs.
// Only these 6 reporters are seeded in comtrade:flows; must stay in sync with
// compute-energy-shock.ts ISO2_TO_COMTRADE.
const ISO2_TO_COMTRADE = {
  US: '842',
  CN: '156',
  RU: '643',
  IR: '364',
  IN: '699',
  TW: '490',
};

// Chokepoints supported by the shock model for comtrade-mapped countries.
const SHOCK_CHOKEPOINTS = ['hormuz', 'malacca', 'suez', 'babelm'];

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisPipeline(commands) {
  return cfPipeline(commands);
}