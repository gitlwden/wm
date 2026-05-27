#!/usr/bin/env node
/**
 * Seed GSCPI (Global Supply Chain Pressure Index) from NY Fed CSV.
 *
 * Source: https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv
 *
 * Extracted from the relay's `startGscpiSeedLoop` so Railway is no longer
 * the sole producer of this key.  GitHub Actions runs on the same 24h
 * schedule and the two producers race on the same Redis key — last write
 * wins, both write the same shape.
 *
 * Redis key: economic:fred:v1:GSCPI:0  (FRED-compatible envelope)
 * Meta key:  seed-meta:economic:gscpi
 */

import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fred:v1:GSCPI:0';
const TTL_SECONDS = 259200; // 72h — 3× the 24h cron; survives 2 missed cycles
const META_TTL_SECONDS = 604800; // 7d

const CSV_URL =
  'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';

// ── CSV parser (mirrors parseGscpiCsv in ais-relay.cjs) ──────────

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseGscpiCsv(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() && !l.startsWith(','));
  const observations = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;

    // Find the last non-empty, non-#N/A value (latest vintage estimate)
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j]?.trim();
      if (v && v !== '#N/A' && v !== '') {
        const num = parseFloat(v);
        if (!Number.isNaN(num)) { value = num; break; }
      }
    }
    if (value === null) continue;

    // Parse "31-Jan-2026" → "2026-01-01"
    const parts = dateStr.split('-');
    if (parts.length !== 3) continue;
    const mon = MONTH_MAP[parts[1]];
    const year = parts[2];
    if (!mon || !year) continue;
    observations.push({ date: `${year}-${mon}-01`, value });
  }

  // Oldest-first (FRED convention)
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Fetcher ──────────────────────────────────────────────────────

async function fetchGscpi() {
  const resp = await fetch(CSV_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const observations = parseGscpiCsv(text);
  if (observations.length === 0) throw new Error('No observations parsed from CSV');

  return {
    series: {
      series_id: 'GSCPI',
      title: 'Global Supply Chain Pressure Index',
      units: 'Standard Deviations',
      frequency: 'Monthly',
      observations,
    },
  };
}

// ── Validation ───────────────────────────────────────────────────

function validate(data) {
  const obs = data?.series?.observations;
  return Array.isArray(obs) && obs.length > 0;
}

// ── Contract ─────────────────────────────────────────────────────

export function declareRecords(data) {
  return data?.series?.observations?.length ?? 0;
}

// ── Entrypoint ───────────────────────────────────────────────────

runSeed('economic', 'gscpi', CANONICAL_KEY, fetchGscpi, {
  validateFn: validate,
  ttlSeconds: TTL_SECONDS,
  sourceVersion: 'nyfed-gscpi',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 4320, // 72h — matches TTL; 3 missed cycles before alert

  afterPublish: async (_data, { recordCount }) => {
    // Write seed-meta key that seed-economy.mjs reads for freshness display
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return;
    const metaKey = 'seed-meta:economic:gscpi';
    const meta = { fetchedAt: Date.now(), recordCount };
    try {
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', META_TTL_SECONDS]),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      console.warn(`  seed-meta write failed: ${e.message}`);
    }
  },
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
