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
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const GAS_STORAGE_KEY_PREFIX = 'energy:gas-storage:v1:';
export const GAS_STORAGE_COUNTRIES_KEY = 'energy:gas-storage:v1:_countries';
export const GAS_STORAGE_META_KEY = 'seed-meta:energy:gas-storage-countries';
export const GAS_STORAGE_TTL_SECONDS = 259200; // 3 days = 3× daily cron

const LOCK_DOMAIN = 'energy:gas-storage-countries';
const LOCK_TTL_MS = 20 * 60 * 1000;
const MIN_VALID_COUNTRIES = 24;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 200;

const GIE_API_BASE = 'https://agsi.gie.eu/api';

/** Full list of EU-28 + UK ISO2 codes to seed */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
];

const COUNTRY_NAMES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
  CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France',
  DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
  LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands',
  PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
  ES: 'Spain', SE: 'Sweden', GB: 'United Kingdom',
};

async function redisPipeline(commands) {
  return cfPipeline(commands);
}