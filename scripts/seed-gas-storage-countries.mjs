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
export async function main() {
  const startedAt = Date.now();
  const runId = `gas-storage-countries:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[gas-storage-countries] Lock held, skipping');
    return;
  }

  const apiKey = process.env.GIE_API_KEY || process.env.AGSI_API_KEY || '';
  if (!apiKey) {
    console.warn('  WARNING: GIE_API_KEY / AGSI_API_KEY not set — attempting unauthenticated requests');
  }

  try {
    // Fetch all countries in batches
    const rawEntries = [];
    for (let i = 0; i < EU_COUNTRIES.length; i += BATCH_SIZE) {
      const batch = EU_COUNTRIES.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (iso2) => {
          const entries = await withRetry(() => fetchCountryData(iso2), 2, 500);
          return { iso2, entries };
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          rawEntries.push(result.value);
        } else {
          console.warn(`  [gas-storage-countries] Failed to fetch country data:`, result.reason?.message || result.reason);
        }
      }
      if (i + BATCH_SIZE < EU_COUNTRIES.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const countries = buildCountriesPayload(rawEntries);

    if (countries.length < MIN_VALID_COUNTRIES) {
      throw new Error(
        `gas-storage-countries: only ${countries.length} valid countries, need >=${MIN_VALID_COUNTRIES}`,
      );
    }

    const seededIso2 = countries.map((c) => c.iso2);
    const metaPayload = {
      fetchedAt: Date.now(),
      recordCount: countries.length,
      sourceVersion: 'gie-agsi-plus-countries-v1',
    };

    const commands = [];
    for (const payload of countries) {
      commands.push([
        'SET',
        `${GAS_STORAGE_KEY_PREFIX}${payload.iso2}`,
        JSON.stringify(payload),
        'EX',
        GAS_STORAGE_TTL_SECONDS,
      ]);
    }
    commands.push([
      'SET',
      GAS_STORAGE_COUNTRIES_KEY,
      JSON.stringify(seededIso2),
      'EX',
      GAS_STORAGE_TTL_SECONDS,
    ]);
    commands.push([
      'SET',
      GAS_STORAGE_META_KEY,
      JSON.stringify(metaPayload),
      'EX',
      GAS_STORAGE_TTL_SECONDS,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(
        `Redis pipeline: ${failures.length}/${commands.length} commands failed`,
      );
    }

    logSeedResult('energy:gas-storage-countries', countries.length, Date.now() - startedAt, {
      countries: seededIso2.join(','),
    });
    console.log(`[gas-storage-countries] Seeded ${countries.length} countries`);
  } catch (err) {
    await preservePreviousSnapshot(String(err)).catch((e) =>
      console.error('[gas-storage-countries] Failed to preserve snapshot:', e),
    );
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-gas-storage-countries.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
