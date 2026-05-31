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
export async function main() {
  const startedAt = Date.now();
  const runId = `energy:spine:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[energy-spine] Lock held by another process, skipping');
    return;
  }

  const writeMeta = async (recordCount, status = 'ok') => {
    const metaPayload = { fetchedAt: Date.now(), recordCount, status };
    await redisPipeline([
      ['SET', SPINE_META_KEY, JSON.stringify(metaPayload), 'EX', SPINE_TTL_SECONDS],
    ]).catch(e => console.warn('[energy-spine] Failed to write seed-meta:', e.message));
  };

  try {
    // Step 1: Collect country list (union of JODI oil + OWID mix countries)
    console.log('[energy-spine] Assembling country list...');
    const { countries, jodiCount, owidCount } = await assembleCountryList();
    if (countries.length === 0) {
      console.error('[energy-spine] No countries found in source keys — aborting');
      await writeMeta(0, 'empty');
      return;
    }

    if (jodiCount === 0 && owidCount === 0) {
      console.error('[energy-spine] Both JODI oil and OWID mix returned zero countries — aborting to preserve snapshot');
      const prevCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
      if (Array.isArray(prevCountries) && prevCountries.length > 0) {
        const prevKeys = prevCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
        await extendExistingTtl([...prevKeys, SPINE_COUNTRIES_KEY, SPINE_META_KEY], SPINE_TTL_SECONDS);
      }
      await writeMeta(0, 'core_sources_empty');
      return;
    }

    console.log(`[energy-spine] ${countries.length} countries to process`);

    // Step 2: Count-drop guard — check against previous _countries count
    const prevCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
    const prevCount = Array.isArray(prevCountries) ? prevCountries.length : 0;
    if (prevCount > 0) {
      const coverageRatio = countries.length / prevCount;
      if (coverageRatio < MIN_COVERAGE_RATIO) {
        console.error(
          `[energy-spine] Count-drop guard triggered: ${countries.length} countries = ` +
          `${(coverageRatio * 100).toFixed(1)}% of previous ${prevCount} — aborting to preserve snapshot`,
        );
        // Extend TTL on existing spine keys
        const prevKeys = prevCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
        await extendExistingTtl(
          [...prevKeys, SPINE_COUNTRIES_KEY, SPINE_META_KEY],
          SPINE_TTL_SECONDS,
        );
        await writeMeta(0, 'count_drop_guard');
        return;
      }
    }

    // Read SPR policy registry once (global key, not per-country)
    const sprRegistry = await redisGet('energy:spr-policies:v1').catch(() => null);
    const sprPolicies = sprRegistry?.policies ?? {};

    // Step 3: Batch-read all 6 domain keys per country via pipeline
    // Order: mix, jodiOil, jodiGas, ieaStocks (electricity + gasStorage excluded — they
    // update sub-daily and are always read directly by handlers, not from the spine)
    console.log('[energy-spine] Reading domain keys in batches...');
    const BATCH_SIZE = 60; // 5 keys * 60 countries = 300 commands per pipeline call
    const spineEntries = new Map();

    for (let i = 0; i < countries.length; i += BATCH_SIZE) {
      const batch = countries.slice(i, i + BATCH_SIZE);
      const keys = [];
      for (const iso2 of batch) {
        keys.push(
          `energy:mix:v1:${iso2}`,
          `energy:jodi-oil:v1:${iso2}`,
          `energy:jodi-gas:v1:${iso2}`,
          `energy:iea-oil-stocks:v1:${iso2}`,
          `energy:ember:v1:${iso2}`,
        );
      }

      const values = await redisMget(keys);

      for (let j = 0; j < batch.length; j++) {
        const iso2 = batch[j];
        const base = j * 5;
        const mix = values[base];
        const jodiOil = values[base + 1];
        const jodiGas = values[base + 2];
        const ieaStocks = values[base + 3];
        const ember = values[base + 4];

        try {
          const sprPolicy = sprPolicies[iso2] ?? null;
          const spine = buildSpineEntry(iso2, { mix, jodiOil, jodiGas, ieaStocks, ember, sprPolicy });
          spineEntries.set(iso2, spine);
        } catch (err) {
          throw new Error(`Schema validation failed for ${iso2}: ${err.message}`);
        }
      }

      console.log(`[energy-spine] Processed ${Math.min(i + BATCH_SIZE, countries.length)}/${countries.length}`);
    }

    // Step 4: Write all spine keys in a single pipeline
    console.log(`[energy-spine] Writing ${spineEntries.size} spine keys...`);
    const commands = [];

    for (const [iso2, entry] of spineEntries) {
      commands.push([
        'SET',
        `${SPINE_KEY_PREFIX}${iso2}`,
        JSON.stringify(entry),
        'EX',
        SPINE_TTL_SECONDS,
      ]);
    }

    // Write _countries index last so it's always a superset
    commands.push([
      'SET',
      SPINE_COUNTRIES_KEY,
      JSON.stringify([...spineEntries.keys()]),
      'EX',
      SPINE_TTL_SECONDS,
    ]);

    // Write seed-meta
    commands.push([
      'SET',
      SPINE_META_KEY,
      JSON.stringify({ fetchedAt: Date.now(), recordCount: spineEntries.size, status: 'ok' }),
      'EX',
      SPINE_TTL_SECONDS,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(
        `Redis pipeline: ${failures.length}/${commands.length} commands failed`,
      );
    }

    logSeedResult('energy:spine', spineEntries.size, Date.now() - startedAt, {
      countries: spineEntries.size,
      ttlH: SPINE_TTL_SECONDS / 3600,
    });
    console.log(`[energy-spine] Seeded ${spineEntries.size} country spine keys`);
  } catch (err) {
    console.error('[energy-spine] Seed failed:', err.message || err);
    // Extend existing snapshot TTL on failure; still write seed-meta with count=0
    const existingCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
    if (Array.isArray(existingCountries) && existingCountries.length > 0) {
      const keys = existingCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
      await extendExistingTtl(
        [...keys, SPINE_COUNTRIES_KEY, SPINE_META_KEY],
        SPINE_TTL_SECONDS,
      ).catch(e => console.warn('[energy-spine] TTL extension failed:', e.message));
    }
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-energy-spine.mjs')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
