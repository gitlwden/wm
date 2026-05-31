import { unwrapEnvelope } from './seed-envelope';
import { buildUpstreamEvent, getUsageScope, sendToAxiom } from './usage';

const KV_OP_TIMEOUT_MS = 180_000;

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
  const creds = getKvCredentials();
  if (!creds) throw new Error('Cloudflare KV credentials not configured');
  const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(key)}`, {
    headers: kvHeaders(creds.token),
    signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`KV HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text) return null;
  // Envelope-aware: contract-mode canonical keys are stored as {_seed, data}.
  // unwrapEnvelope is a no-op on legacy (non-envelope) shapes.
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

  const creds = getKvCredentials();
  if (!creds) return null;

  // In-process cache — skip KV for recently-fetched keys
  const cacheKey = raw ? `raw:${key}` : key;
  const localHit = localCacheGet(cacheKey);
  if (localHit.hit) return localHit.value;

  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
      headers: kvHeaders(creds.token),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text) return null;
    // Envelope-aware by default — RPC consumers get the bare payload regardless
    // of whether the writer has migrated to contract mode. Legacy shapes pass
    // through unchanged (unwrapEnvelope returns {_seed: null, data: raw}).
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

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number, raw = false): Promise<void> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheSet } = await import('./sidecar-cache');
    sidecarCacheSet(key, value, ttlSeconds);
    return;
  }

  const creds = getKvCredentials();
  if (!creds) return;

  // Invalidate local cache so next getCachedJson hits KV
  const cacheKey = raw ? `raw:${key}` : key;
  localCacheInvalidate(cacheKey);

  try {
    const finalKey = raw ? key : prefixKey(key);
    await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}?expiration_ttl=${ttlSeconds}`, {
      method: 'PUT',
      headers: kvHeaders(creds.token, 'application/json'),
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[kv] setCachedJson failed:', errMsg(err));
  }
}

const NEG_SENTINEL = '__WM_NEG__';

/**
 * Batch GET — individual KV reads per key. In-process cache absorbs
 * repeated hits within the same request window.
 * Returns a Map of key → parsed JSON value (missing/failed/sentinel keys omitted).
 */
export async function getCachedJsonBatch(keys: string[], raw = false): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (keys.length === 0) return result;

  const creds = getKvCredentials();
  if (!creds) return result;

  try {
    const reads = keys.map(async (k) => {
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
    });
    await Promise.all(reads);
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

  const creds = getKvCredentials();
  if (!creds) return [];

  const results: Array<{ result?: unknown }> = [];

  for (const cmd of commands) {
    const [verb, key, ...rest] = cmd;
    if (typeof verb !== 'string' || typeof key !== 'string') {
      results.push({});
      continue;
    }
    const finalKey = raw ? key : prefixKey(key);
    try {
      if (verb.toUpperCase() === 'GET') {
        const resp = await fetch(`${kvBase(creds)}/values/${encodeURIComponent(finalKey)}`, {
          headers: kvHeaders(creds.token),
          signal: AbortSignal.timeout(KV_OP_TIMEOUT_MS),
        });
        results.push({ result: resp.ok ? await resp.text() : null });
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
        results.push({ result: 'OK' });
      } else {
        results.push({});
      }
    } catch (err) {
      console.warn(`[kv] runRedisPipeline ${verb} failed:`, errMsg(err));
      results.push({});
    }
  }
  return results;
}

/**
 * Deletes a single key from Cloudflare KV.
 */
export async function deleteRedisKey(key: string, raw = false): Promise<void> {
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

/**
 * In-flight request coalescing map.
 * When multiple concurrent requests hit the same cache key during a miss,
 * only the first triggers the upstream fetch — others await the same promise.
 * This eliminates duplicate upstream API calls within a single Edge Function invocation.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Check cache, then fetch with coalescing on miss.
 * Concurrent callers for the same key share a single upstream fetch + KV write.
 * When fetcher returns null, a sentinel is cached for negativeTtlSeconds to prevent request storms.
 */
export async function cachedFetchJson<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
): Promise<T | null> {
  const cached = await getCachedJson(key);
  if (cached === NEG_SENTINEL) return null;
  if (cached !== null) return cached as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        await setCachedJson(key, result, ttlSeconds);
      } else {
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
  opts?: { usage?: UsageHook },
): Promise<{ data: T | null; source: 'cache' | 'fresh' }> {
  const cached = await getCachedJson(key);
  if (cached === NEG_SENTINEL) return { data: null, source: 'cache' };
  if (cached !== null) return { data: cached as T, source: 'cache' };

  const existing = inflight.get(key);
  if (existing) {
    const data = (await existing) as T | null;
    return { data, source: 'fresh' };
  }

  const fetchT0 = Date.now();
  let upstreamStatus = 0;
  let cacheStatus: 'miss' | 'neg-sentinel' = 'miss';

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        upstreamStatus = 200;
        await setCachedJson(key, result, ttlSeconds);
      } else {
        upstreamStatus = 0;
        cacheStatus = 'neg-sentinel';
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch((err: unknown) => {
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
