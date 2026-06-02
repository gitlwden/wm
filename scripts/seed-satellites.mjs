#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, kvSet } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:satellites:tle:v1';
const SEED_META_KEY = 'seed-meta:intelligence:satellites';
const CACHE_TTL = 172_800; // 48h — daily cron, keep data alive between runs
const META_TTL = 604_800; // 7d
const CELESTRAK_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB per group
const SAT_GROUPS = ['military', 'resource'];

const SAT_NAME_FILTERS = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

function satClassify(name) {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

// ── Cloudflare KV helpers ──────────────────────────────────

async function upstashSet(key, value, ttlSeconds) {
  try {
    await kvSet(key, value, ttlSeconds);
    return true;
  } catch { return false; }
}

async function upstashExpire(key, ttlSeconds) {
  // KV has no separate EXPIRE — re-write with new TTL to refresh
  try {
    await kvSet(key, '1', ttlSeconds);
    return true;
  } catch { return false; }
}

// ── Envelope-aware write (mirrors relay envelopeWrite) ─────────

function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const state = meta?.state || (recordCount === 0 && meta?.zeroOk ? 'OK_ZERO' : 'OK');
  const envelope = buildEnvelope({
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'seed-satellites',
    schemaVersion: meta?.schemaVersion ?? 1,
    state,
    data,
  });
  return upstashSet(key, envelope, ttlSeconds);
}

// ── Fetch TLE group from CelesTrak ─────────────────────────────

async function fetchTleGroup(group) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(CELESTRAK_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CelesTrak ${group}: HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_PAYLOAD_BYTES) {
      reader.cancel();
      throw new Error(`CelesTrak ${group}: payload > ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// ── Main seed logic ────────────────────────────────────────────

async function seedSatelliteTLEs() {
  const t0 = Date.now();
  console.log('[Satellites] Starting seed...');

  const byNorad = new Map();

  for (const group of SAT_GROUPS) {
    let text;
    try {
      text = await fetchTleGroup(group);
    } catch (e) {
      console.warn(`[Satellites] Skipping group ${group}: ${e.message}`);
      continue;
    }

    const lines = text.split('\n').map((l) => l.trimEnd());
    for (let i = 0; i < lines.length - 2; i++) {
      const l1 = lines[i + 1];
      const l2 = lines[i + 2];
      if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
      if (l1.length !== 69 || l2.length !== 69) continue;
      const name = lines[i].trim();
      const noradId = l1.substring(2, 7).trim();
      if (!byNorad.has(noradId)) {
        byNorad.set(noradId, { noradId, name, line1: l1, line2: l2 });
      }
      i += 2;
    }
  }

  const satellites = [];
  for (const sat of byNorad.values()) {
    if (!SAT_NAME_FILTERS.some((rx) => rx.test(sat.name))) continue;
    const { type, country } = satClassify(sat.name);
    satellites.push({ ...sat, type, country });
  }

  if (satellites.length === 0) {
    console.warn('[Satellites] No matching TLEs found — extending existing key TTL');
    await upstashExpire(CANONICAL_KEY, CACHE_TTL);
    console.log('[Satellites] Done (0 satellites, TTL extended)');
    return;
  }

  const payload = { satellites, fetchedAt: Date.now() };
  const ok = await envelopeWrite(CANONICAL_KEY, payload, CACHE_TTL, {
    recordCount: satellites.length,
    sourceVersion: 'celestrak',
  });
  await upstashSet(SEED_META_KEY, { fetchedAt: Date.now(), recordCount: satellites.length }, META_TTL);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Satellites] Seeded ${satellites.length} TLEs (kv: ${ok ? 'OK' : 'FAIL'}) in ${elapsed}s`);
}

seedSatelliteTLEs().catch((e) => {
  console.error('[Satellites] Seed error:', e?.message || e);
  process.exit(1);
});
