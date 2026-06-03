import { unwrapEnvelope } from './seed-envelope';
import { buildUpstreamEvent, getUsageScope, sendToAxiom } from './usage';

const KV_OP_TIMEOUT_MS = 180_000;

// ── Dual-backend routing ─────────────────────────────────────────────
// High-frequency (≤ hourly) seeders and atomic-dependent families → Upstash.
// Low-frequency (≥ 6h) seeders and read-heavy caches → Cloudflare KV.

const CF_PREFIXES = new Set([
  'entitlements:', 'classify:', 'intelligence:energy-shock:',
  'intelligence:route-impact:', 'webcam:list-cache:', 'aviation:delays-bootstrap:',
  'sidecar:', 'brief:',
]);

function extractBasePrefix(key: string): string {
  const vMatch = key.match(/^(.+?):v\d+$/);
  return vMatch ? vMatch[1] : key;
}

function shouldUseUpstash(key: string): boolean {
  let base = extractBasePrefix(key);
  base = base.replace(/^seed-(meta|lock):/, '');
  for (const prefix of CF_PREFIXES) {
    if (base === prefix || base.startsWith(prefix)) return false;
  }
  return true;
}

function getUpstashCredentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function upstashGetRaw(key: string): Promise<string | null> {
  const creds = getUpstashCredentials();
  if (!creds) return null;
  const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ?? null;
}

async function upstashSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const creds = getUpstashCredentials();
  if (!creds) return;
  const cmd = ttlSeconds > 0
    ? ['SET', key, typeof value === 'string' ? value : JSON.stringify(value), 'EX', String(ttlSeconds)]
    : ['SET', key, typeof value === 'string' ? value : JSON.stringify(value)];
  await fetch(`${creds.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd]),
    signal: AbortSignal.timeout(10_000),
  });
}

async function upstashDel(key: string): Promise<void> {
  const creds = getUpstashCredentials();
  if (!creds) return;
  await fetch(`${creds.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['DEL', key]]),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── Cloudflare KV helpers ───────────────────────────────────────────

interface KvCredentials {
  accountId: string;
  namespaceId: string;
  token: string;
}

function getKvCredentials(): KvCredentials | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !namespaceId || !token) return null;
  return { accountId, namespaceId, token };
}

function kvBase(creds: KvCredentials): string {
  return `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${creds.namespaceId}`;
}

function kvHeaders(token: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

// ── In-process TTL cache ─────────────────────────────────────────────
// Avoids redundant KV round-trips when the same key is read multiple
// times within a short window (e.g. bootstrap burst, repeated RPC calls).
// Entries are invalidated on setCachedJson writes.
const _localCache = new Map<string, { value: unknown; expires: number }>();
const LOCAL_CACHE_TTL_MS = 300_000; // 5 min — seed data changes every 6-24h, saves ~90% of reads
const LOCAL_CACHE_MAX = 200;

function localCacheGet(key: string): { hit: true; value: unknown } | { hit: false } {
  const entry = _localCache.get(key);
  if (!entry) return { hit: false };
  if (entry.expires < Date.now()) { _localCache.delete(key); return { hit: false }; }
  return { hit: true, value: entry.value };
}

function localCacheSet(key: string, value: unknown): void {
  _localCache.set(key, { value, expires: Date.now() + LOCAL_CACHE_TTL_MS });
  if (_localCache.size > LOCAL_CACHE_MAX) {
    const oldest = _localCache.keys().next().value;
    if (oldest) _localCache.delete(oldest);
  }
}

function localCacheInvalidate(key: string): void {
  _localCache.delete(key);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasRemoteRedisConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Environment-based key prefix to avoid collisions when multiple deployments
 * share the same KV namespace (M-6 fix).
 */
function getKeyPrefix(): string {
  const env = process.env.VERCEL_ENV; // 'production' | 'preview' | 'development'
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

let cachedPrefix: string | undefined;
function prefixKey(key: string): string {
  if (cachedPrefix === undefined) cachedPrefix = getKeyPrefix();
  if (!cachedPrefix) return key;
  return `${cachedPrefix}${key}`;
}

// Test-only: invalidate the memoized key prefix so a test that mutates
// process.env.VERCEL_ENV / VERCEL_GIT_COMMIT_SHA sees the new value on the
// next read. No production caller should ever invoke this.
export function __resetKeyPrefixCacheForTests(): void {
  cachedPrefix = undefined;
}

type CacheReadResult = { status: 'hit'; value: unknown } | { status: 'miss' } | { status: 'error'; error: unknown };

async function readCachedJson(key: string, raw = false): Promise<CacheReadResult> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    try {
      const { sidecarCacheGet } = await import('./sidecar-cache');
      const value = sidecarCacheGet(key);
      return value == null ? { status: 'miss' } : { status: 'hit', value };
    } catch (error) {
      return { status: 'error', error };
    }
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { status: 'miss' };
  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${url}/get/${encodeURIComponent(finalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
    const data = (await resp.json()) as { result?: string };
    if (!data.result) return { status: 'miss' };
    // Envelope-aware by default — RPC consumers get the bare payload regardless
    // of whether the writer has migrated to contract mode. Legacy shapes pass
    // through unchanged (unwrapEnvelope returns {_seed: null, data: raw}).
    return {
      status: 'hit',
      value: unwrapEnvelope(JSON.parse(data.result)).data,
    };
  } catch (error) {
    return { status: 'error', error };
  }
}

function logCacheReadError(key: string, err: unknown): void {
  // Structured timeout log goes to Sentry via Vercel integration. Large-
  // payload timeouts used to silently return null and let downstream callers
  // cache zero-state — see docs/plans/chokepoint-rpc-payload-split.md for
  // the incident that added this tag.
  //
  // AbortSignal.timeout() throws DOMException name='TimeoutError' (on V8
  // runtimes incl. Vercel Edge); manual controller.abort() throws
  // 'AbortError'. Checking only 'AbortError' meant the [REDIS-TIMEOUT] log
  // never fired — every timeout fell through to the generic console.warn.
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  if (isTimeout) {
    console.error(`[REDIS-TIMEOUT] getCachedJson key=${key} timeoutMs=${REDIS_OP_TIMEOUT_MS}`);
  } else {
    console.warn('[redis] getCachedJson failed:', errMsg(err));
  }
}

/**
 * Like getCachedJson but throws on KV/network failures instead of returning null.
 * Always uses the raw (unprefixed) key — callers that write via seed scripts (which bypass
 * the prefix system) must use this to read the same key they wrote.
 */
export async function getRawJson(key: string): Promise<unknown | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    return sidecarCacheGet(key);
  }
  if (shouldUseUpstash(key)) {
    try {
      const raw = await upstashGetRaw(key);
      if (raw != null) return unwrapEnvelope(JSON.parse(raw)).data;
    } catch { /* fall through to CF KV fallback */ }
    // Fallback: read from Cloudflare KV when Upstash has no data.
    // Handles the migration window where data was written to CF KV
    // before the routing inversion moved writes to Upstash.
    const creds = getKvCredentials();
    if (!creds) return null;
    const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(key)}`, {
      headers: kvHeaders(creds.token),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text) return null;
    return unwrapEnvelope(JSON.parse(text)).data;
  }
  const creds = getKvCredentials();
  if (!creds) throw new Error('Cloudflare KV credentials not configured');
  const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(key)}`, {
    headers: kvHeaders(creds.token),
    signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`KV HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text) return null;
  return unwrapEnvelope(JSON.parse(text)).data;
}

/**
 * Read a key's value as a raw string — no JSON.parse, no envelope unwrap.
 * Use when a seeder stores a bare scalar (e.g., a snapshot_id pointer) via
 * PUT without JSON.stringify. getCachedJson() on these keys silently returns
 * null because JSON.parse throws on unquoted strings, and the try/catch
 * swallows the error.
 *
 * Always uses the raw (unprefixed) key — matches the seed-script write path
 * (seeders don't know about the Vercel env-prefix scheme).
 */
export async function getCachedRawString(key: string): Promise<string | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    const v = sidecarCacheGet(key);
    return typeof v === 'string' ? v : null;
  }
  if (shouldUseUpstash(key)) {
    const raw = await upstashGetRaw(key);
    if (raw != null) return raw;
    // Fallback: read from Cloudflare KV when Upstash has no data.
    const cfCreds = getKvCredentials();
    if (!cfCreds) return null;
    try {
      const resp = await fetch(`${kvBase(cfCreds)}/values/${encodeURIComponent(key)}`, {
        headers: kvHeaders(cfCreds.token),
        signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const text = await resp.text();
      return text.length > 0 ? text : null;
    } catch { return null; }
  }
  const creds = getKvCredentials();
  if (!creds) return null;
  try {
    const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(key)}`, {
      headers: kvHeaders(creds.token),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.length > 0 ? text : null;
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) console.error(`[KV-TIMEOUT] getCachedRawString key=${key} timeoutMs=${KV_OP_TIMEOUT_MS}`);
    else console.warn('[kv] getCachedRawString failed:', errMsg(err));
    return null;
  }
}

export async function getCachedJson(key: string, raw = false): Promise<unknown | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    return sidecarCacheGet(key);
  }

  // In-process cache — skip KV for recently-fetched keys
  const cacheKey = raw ? `raw:${key}` : key;
  const localHit = localCacheGet(cacheKey);
  if (localHit.hit) return localHit.value;

  if (shouldUseUpstash(key)) {
    try {
      const rawVal = await upstashGetRaw(key);
      if (rawVal != null) {
        const parsed = unwrapEnvelope(JSON.parse(rawVal)).data;
        localCacheSet(cacheKey, parsed);
        return parsed;
      }
    } catch { /* fall through to CF KV fallback */ }
    // Fallback: read from Cloudflare KV when Upstash has no data.
    // Handles the migration window where data was written to CF KV
    // before the routing inversion moved writes to Upstash.
    const cfCreds = getKvCredentials();
    if (cfCreds) {
      try {
        const finalKey = raw ? key : prefixKey(key);
        const resp = await fetch(`${kvBase(cfCreds)}/values/${encodeURIComponent(finalKey)}`, {
          headers: kvHeaders(cfCreds.token),
          signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
        });
        if (resp.ok) {
          const text = await resp.text();
          if (text) {
            const parsed = unwrapEnvelope(JSON.parse(text)).data;
            localCacheSet(cacheKey, parsed);
            return parsed;
          }
        }
      } catch { /* CF KV also miss — return null */ }
    }
    return null;
  }

  const creds = getKvCredentials();
  if (!creds) return null;

  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
      headers: kvHeaders(creds.token),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text) return null;
    const parsed = unwrapEnvelope(JSON.parse(text)).data;
    localCacheSet(cacheKey, parsed);
    return parsed;
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) {
      console.error(`[KV-TIMEOUT] getCachedJson key=${key} timeoutMs=${KV_OP_TIMEOUT_MS}`);
    } else {
      console.warn('[kv] getCachedJson failed:', errMsg(err));
    }
    return null;
  }
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number, raw = false): Promise<boolean> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheSet } = await import('./sidecar-cache');
    sidecarCacheSet(key, value, ttlSeconds);
    return true;
  }

  const cacheKey = raw ? `raw:${key}` : key;
  localCacheInvalidate(cacheKey);

  if (shouldUseUpstash(key)) {
    try {
      await upstashSet(key, value, ttlSeconds);
    } catch (err) {
      console.warn('[upstash] setCachedJson failed:', errMsg(err));
    }
    return;
  }

  const creds = getKvCredentials();
  if (!creds) return;

  try {
    const finalKey = raw ? key : prefixKey(key);
    await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}?expiration_ttl=${ttlSeconds}`, {
      method: 'PUT',
      headers: kvHeaders(creds.token, 'application/json'),
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: string;
      error?: string;
    } | null;
    if (!resp.ok || data?.error) {
      console.warn(`[redis] setCachedJson failed:`, data?.error ?? `HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[kv] setCachedJson failed:', errMsg(err));
  }
}

const NEG_SENTINEL = '__WM_NEG__';
const FETCH_ERROR_NEGATIVE_TTL_SECONDS = 30;
const REDIS_FAILURE_POSITIVE_TTL_SECONDS = 30;
const LOCAL_FALLBACK_MAX_ENTRIES = 5000;

const localNegativeUntil = new Map<string, number>();
const localPositiveFallback = new Map<string, { value: unknown; expiresAt: number }>();

function evictOldestLocalFallbackEntries<T>(map: Map<string, T>): void {
  while (map.size > LOCAL_FALLBACK_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) return;
    map.delete(oldestKey);
  }
}

function effectiveFetchErrorNegativeTtlSeconds(negativeTtlSeconds: number): number {
  return Math.max(1, Math.min(negativeTtlSeconds, FETCH_ERROR_NEGATIVE_TTL_SECONDS));
}

function armLocalNegativeCooldown(key: string, ttlSeconds: number): void {
  localNegativeUntil.set(key, Date.now() + ttlSeconds * 1000);
  evictOldestLocalFallbackEntries(localNegativeUntil);
}

function hasLocalNegativeCooldown(key: string): boolean {
  const expiresAt = localNegativeUntil.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  localNegativeUntil.delete(key);
  return false;
}

function effectiveRedisFailurePositiveTtlSeconds(ttlSeconds: number): number {
  return Math.max(1, Math.min(ttlSeconds, REDIS_FAILURE_POSITIVE_TTL_SECONDS));
}

// Positive fallback is only a short isolate-local bridge for Redis outages.
// Keep it capped and clamp caller TTLs so stale fresh data never lingers.
function armLocalPositiveFallback(key: string, value: unknown, ttlSeconds: number): void {
  const effectiveTtlSeconds = effectiveRedisFailurePositiveTtlSeconds(ttlSeconds);
  localPositiveFallback.set(key, {
    value,
    expiresAt: Date.now() + effectiveTtlSeconds * 1000,
  });
  evictOldestLocalFallbackEntries(localPositiveFallback);
}

function readLocalPositiveFallback(key: string): unknown | undefined {
  const cached = localPositiveFallback.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt > Date.now()) return cached.value;
  localPositiveFallback.delete(key);
  return undefined;
}

/**
 * Batch GET — individual KV reads per key. In-process cache absorbs
 * repeated hits within the same request window.
 * Returns a Map of key → parsed JSON value (missing/failed/sentinel keys omitted).
 */
export async function getCachedJsonBatch(keys: string[], raw = false): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (keys.length === 0) return result;

  // Split keys by backend
  const upstashKeys: string[] = [];
  const cfKeys: string[] = [];
  for (const k of keys) {
    (shouldUseUpstash(k) ? upstashKeys : cfKeys).push(k);
  }

  // Upstash reads
  const upstashReads = upstashKeys.map(async (k) => {
    try {
      const rawVal = await upstashGetRaw(k);
      if (rawVal == null) return;
      const parsed = JSON.parse(rawVal);
      if (parsed === NEG_SENTINEL) return;
      result.set(k, unwrapEnvelope(parsed).data);
    } catch { /* skip malformed */ }
  });

  // Cloudflare reads
  const creds = getKvCredentials();
  const cfReads = creds ? cfKeys.map(async (k) => {
    const finalKey = raw ? k : prefixKey(k);
    try {
      const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
        headers: kvHeaders(creds.token),
        signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
      });
      if (!resp.ok) return;
      const text = await resp.text();
      if (!text) return;
      const parsed = JSON.parse(text);
      if (parsed === NEG_SENTINEL) return;
      result.set(k, unwrapEnvelope(parsed).data);
    } catch { /* skip malformed */ }
  }) : [];

  try {
    await Promise.all([...upstashReads, ...cfReads]);
  } catch (err) {
    console.warn('[kv] getCachedJsonBatch failed:', errMsg(err));
  }
  return result;
}

export type RedisPipelineCommand = Array<string | number>;

/**
 * Pipeline adapter — runs each command as an individual KV operation.
 * Only GET and SET are supported; other commands are silently skipped.
 */
export async function runRedisPipeline(
  commands: RedisPipelineCommand[],
  raw = false,
): Promise<Array<{ result?: unknown }>> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') return [];
  if (commands.length === 0) return [];

  const results: Array<{ result?: unknown }> = new Array(commands.length);

  // Split commands by backend
  const upstashIdx: number[] = [];
  const cfIdx: number[] = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (typeof cmd[0] !== 'string' || typeof cmd[1] !== 'string') {
      results[i] = {};
      continue;
    }
    (shouldUseUpstash(cmd[1] as string) ? upstashIdx : cfIdx).push(i);
  }

  // Upstash batch
  if (upstashIdx.length > 0) {
    try {
      const upstashCmds = upstashIdx.map(i => commands[i]);
      const creds = getUpstashCredentials();
      if (creds) {
        const resp = await fetch(`${creds.url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(upstashCmds),
          signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
        });
        if (resp.ok) {
          const data = await resp.json();
          for (let j = 0; j < upstashIdx.length; j++) {
            results[upstashIdx[j]] = data[j] || {};
          }
        } else {
          for (const i of upstashIdx) results[i] = {};
        }
      } else {
        for (const i of upstashIdx) results[i] = {};
      }
    } catch (err) {
      console.warn('[upstash] runRedisPipeline failed:', errMsg(err));
      for (const i of upstashIdx) results[i] = {};
    }
  }

  // Cloudflare KV batch
  const creds = getKvCredentials();
  for (const i of cfIdx) {
    const cmd = commands[i];
    const [verb, key, ...rest] = cmd;
    if (typeof verb !== 'string' || typeof key !== 'string') { results[i] = {}; continue; }
    const finalKey = raw ? key : prefixKey(key);
    try {
      if (!creds) { results[i] = {}; continue; }
      if (verb.toUpperCase() === 'GET') {
        const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
          headers: kvHeaders(creds.token),
          signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
        });
        results[i] = { result: resp.ok ? await resp.text() : null };
      } else if (verb.toUpperCase() === 'SET') {
        const value = rest[0];
        const ttlIdx = rest.indexOf('EX');
        const ttl = ttlIdx >= 0 ? rest[ttlIdx + 1] : 3600;
        const params = typeof ttl === 'number' ? `?expiration_ttl=${ttl}` : '';
        await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}${params}`, {
          method: 'PUT',
          headers: kvHeaders(creds.token, 'application/json'),
          body: typeof value === 'string' ? value : JSON.stringify(value),
          signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
        });
        results[i] = { result: 'OK' };
      } else {
        results[i] = {};
      }
    } catch (err) {
      console.warn(`[kv] runRedisPipeline ${verb} failed:`, errMsg(err));
      results[i] = {};
    }
  }
  return results;
}

/**
 * Deletes a single key from Cloudflare KV.
 */
export async function deleteRedisKey(key: string, raw = false): Promise<void> {
  if (shouldUseUpstash(key)) {
    try {
      await upstashDel(key);
    } catch (err) {
      console.warn('[upstash] deleteRedisKey failed:', errMsg(err));
    }
    return;
  }

  const creds = getKvCredentials();
  if (!creds) return;

  try {
    const finalKey = raw ? key : prefixKey(key);
    await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
      method: 'DELETE',
      headers: kvHeaders(creds.token),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[kv] deleteRedisKey failed:', errMsg(err));
  }
}

export async function compareAndDeleteRedisKey(key: string, expectedValue: string, raw = false): Promise<boolean> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') return false;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !expectedValue) return false;

  const finalKey = raw ? key : prefixKey(key);
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  try {
    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['EVAL', script, '1', finalKey, expectedValue]),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[redis] compareAndDeleteRedisKey HTTP ${response.status}`);
      return false;
    }
    const data = (await response.json().catch(() => null)) as {
      result?: unknown;
      error?: string;
    } | null;
    if (data?.error) {
      console.warn('[redis] compareAndDeleteRedisKey failed:', data.error);
      return false;
    }
    return data?.result === 1;
  } catch (err) {
    console.warn('[redis] compareAndDeleteRedisKey failed:', errMsg(err));
    return false;
  }
}

/**
 * In-flight request coalescing map.
 * When multiple concurrent requests hit the same cache key during a miss,
 * only the first triggers the upstream fetch — others await the same promise.
 * This eliminates duplicate upstream API calls within a single Edge Function invocation.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Default upper bound on how long a single fetcher may run before its
 * inflight entry is forced to settle (#3539).
 *
 * Without this, a fetcher with no internal timeout (no AbortController, no
 * `fetch` `signal`) that truly never settles persists in the inflight Map
 * for the lifetime of the Vercel isolate — every subsequent caller for that
 * key gets handed the same unresolved promise, permanently poisoning it.
 *
 * 30s comfortably exceeds well-behaved HTTP fetchers (UPSTREAM_TIMEOUT_MS is
 * typically 5–15s), so this only fires on misbehaving callers. Callers whose
 * fetcher legitimately runs longer (LLM reasoning, multi-stage aggregations)
 * MUST pass an explicit `opts.timeoutMs` set above their internal budget,
 * otherwise the cache layer will pre-empt the caller's own timeout/fallback.
 */
const FETCHER_TIMEOUT_MS_DEFAULT = 30_000;
let fetcherTimeoutDefaultMs = FETCHER_TIMEOUT_MS_DEFAULT;

// Test-only: override the DEFAULT inflight timeout so unit tests can exercise
// the timeout branch without sleeping for 30s. Per-call `opts.timeoutMs` still
// wins. No production caller should ever invoke this.
export function __setFetcherTimeoutForTests(ms: number): void {
  fetcherTimeoutDefaultMs = ms;
}
export function __resetFetcherTimeoutForTests(): void {
  fetcherTimeoutDefaultMs = FETCHER_TIMEOUT_MS_DEFAULT;
}

/**
 * Race the fetcher promise against a setTimeout so the inflight slot is
 * guaranteed to settle even if the fetcher hangs forever. The timer is
 * cleared as soon as the fetcher wins so we don't leak handles or keep the
 * isolate awake unnecessarily.
 *
 * Known limitation: this only times out the cache-layer wrapper — the
 * underlying fetcher promise is NOT cancelled. A truly hung upstream
 * fetcher continues running in the background until the isolate recycles
 * (~socket + small heap residue per orphan). Inflight-slot release means
 * subsequent callers re-fetch successfully, so user-facing behavior is
 * correct; only resource-cost is affected. True cancellation would require
 * threading an AbortSignal through the fetcher contract, which is a wider
 * refactor across every cached-fetch call site.
 */
function withFetcherTimeout<T>(promise: Promise<T>, key: string, timeoutMs: number, callerName: 'cachedFetchJson' | 'cachedFetchJsonWithMeta'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${callerName} timeout after ${timeoutMs}ms for "${key}"`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Per-call cache-helper options.
 *
 * - `timeoutMs`: Hard upper bound on the fetcher. Defaults to 30s. Pass a
 *   value above the caller's internal timeout (LLM `timeoutMs`, aggregated
 *   `UPSTREAM_TIMEOUT_MS` sum) so the cache layer doesn't pre-empt the
 *   caller's own bound. The cache safety net should be the LAST resort.
 */
export interface CachedFetchOpts {
  timeoutMs?: number;
}

/**
 * Check cache, then fetch with coalescing on miss.
 * Concurrent callers for the same key share a single upstream fetch + KV write.
 * When fetcher returns null, a sentinel is cached for negativeTtlSeconds to prevent request storms.
 *
 * The fetcher is force-rejected after `opts.timeoutMs` (default 30s, #3539)
 * so a misbehaving fetcher cannot poison the inflight Map for the isolate
 * lifetime. Callers with legitimately long-running fetchers (LLM, multi-stage
 * upstream aggregation) MUST pass `opts.timeoutMs` above their internal bound.
 */
export async function cachedFetchJson<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
  opts?: CachedFetchOpts,
): Promise<T | null> {
  const cached = await readCachedJson(key);
  if (cached.status === 'hit') {
    if (cached.value === NEG_SENTINEL) return null;
    return cached.value as T;
  }
  const localPositive = readLocalPositiveFallback(key);
  if (localPositive !== undefined) return localPositive as T;
  const hadCacheReadError = cached.status === 'error';
  if (cached.status === 'error') {
    logCacheReadError(key, cached.error);
    if (hasLocalNegativeCooldown(key)) return null;
  }

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const timeoutMs = opts?.timeoutMs ?? fetcherTimeoutDefaultMs;
  const promise = withFetcherTimeout(fetcher(), key, timeoutMs, 'cachedFetchJson')
    .then(async (result) => {
      if (result != null) {
        const wrote = await setCachedJson(key, result, ttlSeconds);
        // Remote Redis write/read failures should not force every caller back
        // upstream while the isolate is still warm. Sidecar/local mode skips
        // this bridge because hasRemoteRedisConfig() is false there.
        if (hadCacheReadError || (!wrote && hasRemoteRedisConfig())) {
          armLocalPositiveFallback(key, result, ttlSeconds);
        }
      } else {
        armLocalNegativeCooldown(key, negativeTtlSeconds);
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch((err: unknown) => {
      console.warn(`[kv] cachedFetchJson fetcher failed for "${key}":`, errMsg(err));
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * Per-call usage-telemetry hook for upstream event emission (issue #3381).
 */
export interface UsageHook {
  provider: string;
  operation?: string;
  host?: string;
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
  requestId?: string;
  customerId?: string | null;
  route?: string;
  tier?: number;
}

/**
 * Like cachedFetchJson but reports the data source.
 * Returns { data, source } where source is:
 *   'cache'  — served from KV
 *   'fresh'  — fetcher ran (leader) or joined an in-flight fetch (follower)
 */
export async function cachedFetchJsonWithMeta<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
  opts?: { usage?: UsageHook; timeoutMs?: number },
): Promise<{ data: T | null; source: 'cache' | 'fresh' }> {
  const cached = await readCachedJson(key);
  if (cached.status === 'hit') {
    if (cached.value === NEG_SENTINEL) return { data: null, source: 'cache' };
    return { data: cached.value as T, source: 'cache' };
  }
  const localPositive = readLocalPositiveFallback(key);
  if (localPositive !== undefined) return { data: localPositive as T, source: 'cache' };
  const hadCacheReadError = cached.status === 'error';
  if (cached.status === 'error') {
    logCacheReadError(key, cached.error);
    if (hasLocalNegativeCooldown(key)) return { data: null, source: 'cache' };
  }

  const existing = inflight.get(key);
  if (existing) {
    const data = (await existing) as T | null;
    return { data, source: 'fresh' };
  }

  const fetchT0 = Date.now();
  let upstreamStatus = 0;
  let cacheStatus: 'miss' | 'neg-sentinel' = 'miss';

  const timeoutMs = opts?.timeoutMs ?? fetcherTimeoutDefaultMs;
  const promise = withFetcherTimeout(fetcher(), key, timeoutMs, 'cachedFetchJsonWithMeta')
    .then(async (result) => {
      if (result != null) {
        upstreamStatus = 200;
        const wrote = await setCachedJson(key, result, ttlSeconds);
        // See cachedFetchJson(): this short in-process bridge is only for
        // remote Redis outages, not local sidecar cache writes.
        if (hadCacheReadError || (!wrote && hasRemoteRedisConfig())) {
          armLocalPositiveFallback(key, result, ttlSeconds);
        }
      } else {
        upstreamStatus = 0;
        cacheStatus = 'neg-sentinel';
        armLocalNegativeCooldown(key, negativeTtlSeconds);
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch(async (err: unknown) => {
      upstreamStatus = 0;
      console.warn(`[kv] cachedFetchJsonWithMeta fetcher failed for "${key}":`, errMsg(err));
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  let data: T | null;
  try {
    data = await promise;
  } finally {
    emitUpstreamFromHook(opts?.usage, upstreamStatus, Date.now() - fetchT0, cacheStatus);
  }
  return { data, source: 'fresh' };
}

function emitUpstreamFromHook(
  usage: UsageHook | undefined,
  status: number,
  durationMs: number,
  cacheStatus: 'miss' | 'fresh' | 'stale-while-revalidate' | 'neg-sentinel',
): void {
  if (!usage?.provider) return;
  const scope = getUsageScope();
  const ctx = usage.ctx ?? scope?.ctx;
  if (!ctx) return;
  const event = buildUpstreamEvent({
    requestId: usage.requestId ?? scope?.requestId ?? '',
    customerId: usage.customerId ?? scope?.customerId ?? null,
    route: usage.route ?? scope?.route ?? '',
    tier: usage.tier ?? scope?.tier ?? 0,
    provider: usage.provider,
    operation: usage.operation ?? 'fetch',
    host: usage.host ?? '',
    status,
    durationMs,
    requestBytes: 0,
    responseBytes: 0,
    cacheStatus,
  });
  try {
    ctx.waitUntil(sendToAxiom([event]));
  } catch {
    /* telemetry must never throw */
  }
}
