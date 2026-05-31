#!/usr/bin/env node

// Standalone corridor risk seed — fetches shipping corridor risk scores from
// corridorrisk.io, maps to canonical chokepoint IDs, writes to Cloudflare KV.
// Extracted from ais-relay.cjs startCorridorRiskSeedLoop / seedCorridorRisk.

import { buildEnvelope } from './_seed-envelope-source.mjs';
import { loadEnvFile, getKvBase, getKvToken } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ── KV helpers ─────────────────────────────────────────────────────────

const kvBase = getKvBase();
const kvToken = getKvToken();

async function redisSet(key, value, ttlSeconds) {
  try {
    const resp = await fetch(`${kvBase}/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch { return false; }
}

function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const state = meta?.state || (recordCount === 0 && meta?.zeroOk ? 'OK_ZERO' : 'OK');
  const envelope = buildEnvelope({
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'corridor-risk',
    schemaVersion: meta?.schemaVersion ?? 1,
    state,
    data,
  });
  return redisSet(key, envelope, ttlSeconds);
}

// ── Constants ─────────────────────────────────────────────────────────────

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CORRIDOR_RISK_BASE_URL = 'https://corridorrisk.io/api/corridors';
const CORRIDOR_RISK_REDIS_KEY = 'supply_chain:corridorrisk:v1';
const CORRIDOR_RISK_TTL = 14400; // 4h

// API name -> canonical chokepoint ID (partial substring match)
const CORRIDOR_RISK_NAME_MAP = [
  { pattern: 'hormuz', id: 'hormuz_strait' },
  { pattern: 'bab-el-mandeb', id: 'bab_el_mandeb' },
  { pattern: 'red sea', id: 'bab_el_mandeb' },
  { pattern: 'suez', id: 'suez' },
  { pattern: 'south china sea', id: 'taiwan_strait' },
  { pattern: 'black sea', id: 'bosphorus' },
];

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('[CorridorRisk] Seed starting...');
  const t0 = Date.now();

  const resp = await fetch(CORRIDOR_RISK_BASE_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      Referer: 'https://corridorrisk.io/dashboard.html',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.warn(`[CorridorRisk] HTTP ${resp.status} (${resp.headers.get('content-type') || 'unknown'}) — ${body.slice(0, 200)}`);
    process.exit(0);
  }

  const text = await resp.text();
  if (text.startsWith('<')) {
    console.warn(`[CorridorRisk] Got HTML instead of JSON (Cloudflare challenge?) — ${text.slice(0, 150)}`);
    process.exit(0);
  }

  const corridors = JSON.parse(text);
  if (!Array.isArray(corridors) || !corridors.length) {
    console.warn('[CorridorRisk] No corridors returned — skipping');
    process.exit(0);
  }

  const result = {};
  for (const corridor of corridors) {
    const name = (corridor.name || '').toLowerCase();
    const mapping = CORRIDOR_RISK_NAME_MAP.find((m) => name.includes(m.pattern));
    if (!mapping) continue;
    const score = Number(corridor.score ?? 0);
    const riskLevel = score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'elevated' : 'normal';
    result[mapping.id] = {
      riskLevel,
      riskScore: score,
      incidentCount7d: Number(corridor.incident_count_7d ?? 0),
      eventCount7d: Number(corridor.event_count_7d ?? 0),
      disruptionPct: Number(corridor.disruption_pct ?? 0),
      vesselCount: Number(corridor.vessel_count ?? 0),
      riskSummary: String(corridor.risk_summary || '').slice(0, 200),
      riskReportAction: String((corridor.risk_report?.action) || '').slice(0, 500),
    };
  }

  if (Object.keys(result).length === 0) {
    console.warn('[CorridorRisk] No matching corridors — skipping');
    process.exit(0);
  }

  const ok = await envelopeWrite(CORRIDOR_RISK_REDIS_KEY, result, CORRIDOR_RISK_TTL, {
    recordCount: Object.keys(result).length,
    sourceVersion: 'corridor-risk',
  });
  await redisSet('seed-meta:supply_chain:corridorrisk', { fetchedAt: Date.now(), recordCount: Object.keys(result).length }, 604800);

  console.log(`[CorridorRisk] Seeded ${Object.keys(result).length} corridors (kv: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('[CorridorRisk] Fatal error:', e?.message || e);
  process.exit(1);
});
