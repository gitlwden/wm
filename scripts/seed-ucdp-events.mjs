#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { kvSet, kvGet } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REDIS_KEY = 'conflict:ucdp-events:v1';
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 6;
const MAX_EVENTS = 2000; // TODO: review cap after observing real map density & panel usage
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadEnvFile() {
  let envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) {
    envPath = join('/Users/eliehabib/Documents/GitHub/worldmonitor', '.env.local');
  }
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function buildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchGedPage(version, page, token) {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(90_000) },
  );
  if (!resp.ok) throw new Error(`UCDP GED API error (${version}, page ${page}): ${resp.status}`);
  return resp.json();
}

async function discoverVersion(token) {
  const candidates = buildVersionCandidates();
  console.log(`  Probing versions sequentially: ${candidates.join(', ')}`);
  for (const version of candidates) {
    try {
      console.log(`  Trying v${version}...`);
      const page0 = await fetchGedPage(version, 0, token);
      if (!Array.isArray(page0?.Result)) continue;
      console.log(`  Found v${version} with ${page0.Result.length} events on page 0`);
      return { version, page0 };
    } catch (err) {
      console.warn(`  v${version} failed: ${err.message}`);
    }
  }
  throw new Error('No valid UCDP GED version found');
}

function parseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

async function main() {
  loadEnvFile();

  const ucdpToken = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();

  console.log('=== UCDP Events Seed ===');
  console.log(`  UCDP Token: ${ucdpToken ? maskToken(ucdpToken) : '(none — unauthenticated)'}`);
  console.log();

  const { version, page0 } = await discoverVersion(ucdpToken);
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;
  console.log(`  Version: ${version} | Total pages: ${totalPages}`);

  const FAILED = Symbol('failed');
  const pagesToFetch = [];
  for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    if (page === 0) {
      pagesToFetch.push(Promise.resolve(page0));
    } else {
      pagesToFetch.push(fetchGedPage(version, page, ucdpToken).catch(() => FAILED));
    }
  }

  const pageResults = await Promise.all(pagesToFetch);

  const allEvents = [];
  let latestDatasetMs = NaN;
  let failedPages = 0;

  for (const rawData of pageResults) {
    if (rawData === FAILED) { failedPages++; continue; }
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents.push(...events);
    const pageMaxMs = getMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
  }

  console.log(`  Raw events: ${allEvents.length} | Failed pages: ${failedPages}`);

  const filtered = allEvents.filter((event) => {
    if (!Number.isFinite(latestDatasetMs)) return true;
    const eventMs = parseDateMs(event?.date_start);
    if (!Number.isFinite(eventMs)) return false;
    return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
  });

  console.log(`  After 1-year trailing window: ${filtered.length}`);

  const mapped = filtered.map((e) => ({
    id: String(e.id || ''),
    dateStart: Date.parse(e.date_start) || 0,
    dateEnd: Date.parse(e.date_end) || 0,
    location: {
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
    },
    country: e.country || '',
    sideA: (e.side_a || '').substring(0, 200),
    sideB: (e.side_b || '').substring(0, 200),
    deathsBest: Number(e.best) || 0,
    deathsLow: Number(e.low) || 0,
    deathsHigh: Number(e.high) || 0,
    violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
    sourceOriginal: (e.source_original || '').substring(0, 300),
  }));

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  const capped = mapped.slice(0, MAX_EVENTS);
  if (mapped.length > MAX_EVENTS) console.log(`  Capped: ${mapped.length} → ${MAX_EVENTS}`);

  // Guard: never overwrite existing data with empty results.
  // Extend TTL on existing key instead so health stays OK.
  if (capped.length === 0) {
    console.warn(`  0 events after processing — extending existing key TTL (preserving last good data)`);
    try {
      // KV has no separate EXPIRE — re-write to refresh TTL
      await kvSet(REDIS_KEY, '1', 86400);
      await kvSet('seed-meta:conflict:ucdp-events', '1', 604800);
      console.log(`  Extended TTL on ${REDIS_KEY} and seed-meta`);
    } catch (e) { console.warn(`  TTL extension failed: ${e.message}`); }
    process.exit(0);
  }

  const payload = {
    events: capped,
    fetchedAt: Date.now(),
    version,
    totalRaw: allEvents.length,
    filteredCount: mapped.length,
  };

  console.log(`  Mapped: ${mapped.length} events`);
  if (mapped[0]) {
    console.log(`  Newest: ${new Date(mapped[0].dateStart).toISOString().slice(0, 10)} — ${mapped[0].country}`);
  }
  console.log();

  try {
    await kvSet(REDIS_KEY, payload, 86400);
  } catch (e) {
    console.error(`KV SET failed: ${e.message}`);
    process.exit(1);
  }

  console.log('  KV SET result: OK');

  // Write seed-meta for health endpoint freshness tracking
  const metaKey = 'seed-meta:conflict:ucdp-events';
  const meta = { fetchedAt: Date.now(), recordCount: capped.length };
  try {
    await kvSet(metaKey, meta, 604800);
    console.log(`  Wrote seed-meta: ${metaKey}`);
  } catch { console.error('  seed-meta write failed'); }

  try {
    const raw = await kvGet(REDIS_KEY);
    if (raw) {
      const parsed = unwrapEnvelope(raw).data;
      console.log(`\n  Verified: ${parsed.events?.length} events in KV`);
      console.log(`  Version: ${parsed.version} | fetchedAt: ${new Date(parsed.fetchedAt).toISOString()}`);
    }
  } catch { /* verify failed */ }

  console.log('\n=== Done ===');
}

main().catch(err => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  // Exit gracefully for cron — crashing restarts the container unnecessarily.
  // The health endpoint will flag stale data via seed-meta.
  process.exit(0);
});
