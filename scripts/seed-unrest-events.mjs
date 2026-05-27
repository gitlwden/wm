#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, httpsProxyFetchRaw, resolveProxyForConnect, describeErr } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const GDELT_GKG_URL = 'https://api.gdeltproject.org/api/v1/gkg_geojson';
const CANONICAL_KEY = 'unrest:events:v1';
const CACHE_TTL = 16200; // 4.5h
const MAX_SOURCE_URLS = 5;

// ---------- Severity Classification ----------

function classifyGdeltSeverity(count, name) {
  const lowerName = name.toLowerCase();
  if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash')) return 'SEVERITY_LEVEL_HIGH';
  if (count < 25) return 'SEVERITY_LEVEL_LOW';
  return 'SEVERITY_LEVEL_MEDIUM';
}

function classifyGdeltEventType(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lowerName.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lowerName.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  return 'UNREST_EVENT_TYPE_PROTEST';
}

function normalizeSourceUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function uniqueSourceUrls(values) {
  return [...new Set(values.map(normalizeSourceUrl).filter(Boolean))];
}

function extractGdeltSourceUrls(properties = {}) {
  return mergeSourceUrls([
    properties.url,
    properties.source_url,
    properties.sourceUrl,
    properties.document_url,
    properties.documentUrl,
    properties.article_url,
    properties.articleUrl,
  ]);
}

function mergeSourceUrls(...groups) {
  return uniqueSourceUrls(groups.flatMap((group) => Array.isArray(group) ? group : [])).slice(0, MAX_SOURCE_URLS);
}

// ---------- Sort ----------

function sortBySeverityAndRecency(events) {
  const severityOrder = {
    SEVERITY_LEVEL_HIGH: 0,
    SEVERITY_LEVEL_MEDIUM: 1,
    SEVERITY_LEVEL_LOW: 2,
    SEVERITY_LEVEL_UNSPECIFIED: 3,
  };
  return events.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.occurredAt - a.occurredAt;
  });
}

// ---------- GDELT Fetch ----------

// Direct fetch from Railway has 0% success — every attempt errors with
// UND_ERR_CONNECT_TIMEOUT or ECONNRESET. Path is always proxy-only here.
// Decodo→Cloudflare→GDELT occasionally returns 522 or RSTs the TLS handshake
// (~80% per single attempt in production); retry-with-jitter recovers most of
// it without touching the cron interval.
//
// Test seams:
//   _proxyFetcher  — replaces httpsProxyFetchRaw (default production wiring).
//   _sleep         — replaces the inter-attempt jitter delay.
//   _maxAttempts   — replaces the default 3 (lets tests bound iterations).
//   _jitter        — replaces Math.random()-based jitter (deterministic in tests).
export async function fetchGdeltViaProxy(url, proxyAuth, opts = {}) {
  const {
    _proxyFetcher = httpsProxyFetchRaw,
    _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    _maxAttempts = 3,
    _jitter = () => 1500 + Math.random() * 1500,
  } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= _maxAttempts; attempt++) {
    try {
      const { buffer } = await _proxyFetcher(url, proxyAuth, {
        accept: 'application/json',
        timeoutMs: 45_000,
      });
      return JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      lastErr = err;
      // JSON.parse on a successfully fetched body is deterministic — retrying
      // can't recover. Bail immediately so we don't burn three attempts on
      // a malformed-but-cached upstream response.
      if (err instanceof SyntaxError) throw err;
      if (attempt < _maxAttempts) {
        console.warn(`  [GDELT] proxy attempt ${attempt}/${_maxAttempts} failed (${describeErr(err)}); retrying`);
        await _sleep(_jitter());
      }
    }
  }
  throw lastErr;
}

export async function fetchGdeltEvents(opts = {}) {
  const { _resolveProxyForConnect = resolveProxyForConnect, ..._proxyOpts } = opts;
  const params = new URLSearchParams({
    query: 'protest OR riot OR demonstration OR strike',
    maxrows: '2500',
  });
  const url = `${GDELT_GKG_URL}?${params}`;

  const proxyAuth = _resolveProxyForConnect();
  if (!proxyAuth) {
    // Direct fetch hasn't worked from Railway since PR #3256; this seeder
    // hard-requires a CONNECT proxy. Surface the env var ops needs to set.
    throw new Error('GDELT requires CONNECT proxy: PROXY_URL env var is not set on this Railway service');
  }

  let data;
  try {
    data = await fetchGdeltViaProxy(url, proxyAuth, _proxyOpts);
  } catch (proxyErr) {
    throw Object.assign(
      new Error(`GDELT proxy failed (3 attempts): ${describeErr(proxyErr)}`),
      { cause: proxyErr },
    );
  }

  const features = data?.features || [];

  // Aggregate by location (v1 GKG returns individual mentions, not aggregated counts)
  const locationMap = new Map();
  for (const feature of features) {
    const name = feature.properties?.name || '';
    if (!name) continue;

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      if (feature.properties?.urltone < existing.worstTone) {
        existing.worstTone = feature.properties.urltone;
      }
      existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, extractGdeltSourceUrls(feature.properties));
    } else {
      locationMap.set(key, {
        name,
        lat,
        lon,
        count: 1,
        worstTone: feature.properties?.urltone ?? 0,
        sourceUrls: mergeSourceUrls(extractGdeltSourceUrls(feature.properties)),
      });
    }
  }

  const events = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 5) continue;

    const country = loc.name.split(',').pop()?.trim() || loc.name;
    events.push({
      id: `gdelt-${loc.lat.toFixed(2)}-${loc.lon.toFixed(2)}-${Date.now()}`,
      title: `${loc.name} (${loc.count} reports)`,
      summary: '',
      eventType: classifyGdeltEventType(loc.name),
      city: loc.name.split(',')[0]?.trim() || '',
      country,
      region: '',
      location: { latitude: loc.lat, longitude: loc.lon },
      occurredAt: Date.now(),
      severity: classifyGdeltSeverity(loc.count, loc.name),
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT',
      tags: [],
      actors: [],
      confidence: loc.count > 20 ? 'CONFIDENCE_LEVEL_HIGH' : 'CONFIDENCE_LEVEL_MEDIUM',
      sourceUrls: loc.sourceUrls,
    });
  }

  console.log(`  GDELT: ${features.length} mentions → ${events.length} aggregated events`);
  return events;
}

// ---------- Main Fetch ----------

async function fetchUnrestEvents() {
  const gdeltEvents = await fetchGdeltEvents();
  const sorted = sortBySeverityAndRecency(gdeltEvents);

  console.log(`  GDELT: ${gdeltEvents.length} events (GDELT-only)`);

  return { events: sorted, clusters: [], pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

// Gate the runSeed entry-point so this module is importable from tests
// without triggering a real seed run. process.argv[1] is set when this file
// is invoked as a script (`node scripts/seed-unrest-events.mjs`); under
// `node --test`, argv[1] is the test runner, not this file.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runSeed('unrest', 'events', CANONICAL_KEY, fetchUnrestEvents, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'gdelt',

    declareRecords,
    schemaVersion: 2,
    maxStaleMin: 120,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
