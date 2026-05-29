// server/_shared/llm-health.ts
// Lightweight LLM provider health gate.
// Probes provider URLs with a fast request, caches results.
// All LLM call sites check this before attempting expensive fetch calls.

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000; // re-probe every 60s
const AUTH_FAIL_TTL_MS = 5 * 60_000; // auth errors: re-probe after 5min

interface HealthEntry {
  available: boolean;
  checkedAt: number;
  /** TTL for this entry — shorter for auth failures */
  ttlMs: number;
}

const cache = new Map<string, HealthEntry>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Auth-aware probe: sends a minimal chat completion to verify the API key works.
 * Returns { ok, statusCode } so the caller can decide TTL based on failure type.
 */
async function probeAuth(apiUrl: string, headers: Record<string, string>): Promise<{ ok: boolean; statusCode: number }> {
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 200 = works, 400 = model not found but auth OK, 404 = endpoint exists
    // 401/403/402 = auth/credits problem
    return { ok: resp.status < 401, statusCode: resp.status };
  } catch {
    return { ok: false, statusCode: 0 };
  }
}

/**
 * Resolve auth headers for known LLM providers.
 */
function getAuthHeaders(apiUrl: string): Record<string, string> {
  const origin = new URL(apiUrl).origin;
  if (origin === 'https://api.groq.com') {
    const key = process.env.GROQ_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  if (origin === 'https://openrouter.ai') {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  return {};
}

/**
 * Check if an LLM provider endpoint is available.
 * Returns cached result if fresh (< entry.ttlMs old).
 * Otherwise probes with auth verification and caches the result.
 */
export async function isProviderAvailable(apiUrl: string): Promise<boolean> {
  const origin = new URL(apiUrl).origin;
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.checkedAt < cached.ttlMs) {
    return cached.available;
  }

  // Coalesce concurrent probes to the same origin
  const existing = inFlight.get(origin);
  if (existing) return existing;

  const promise = (async () => {
    const authHeaders = getAuthHeaders(apiUrl);
    const hasAuth = Object.keys(authHeaders).length > 0;

    let available: boolean;
    let ttlMs = CACHE_TTL_MS;

    if (hasAuth) {
      // Auth-aware probe: verify API key actually works
      const result = await probeAuth(apiUrl, authHeaders);
      available = result.ok;
      if (!available && result.statusCode >= 401 && result.statusCode <= 403) {
        // Auth/credits failure — use shorter TTL so we retry sooner
        ttlMs = AUTH_FAIL_TTL_MS;
        console.warn(`[llm-health] Auth probe failed for ${origin}: HTTP ${result.statusCode} — retry in ${AUTH_FAIL_TTL_MS / 1000}s`);
      } else if (!available) {
        console.warn(`[llm-health] Provider unreachable: ${origin}`);
      }
    } else {
      // No auth headers (Ollama, generic) — just check TCP reachability
      try {
        await fetch(origin, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        available = true;
      } catch {
        available = false;
        console.warn(`[llm-health] Provider unreachable: ${origin}`);
      }
    }

    cache.set(origin, { available, checkedAt: Date.now(), ttlMs });
    inFlight.delete(origin);
    return available;
  })();
  inFlight.set(origin, promise);
  return promise;
}

/**
 * Get current health status for all probed providers.
 * Used by /api/health to expose LLM status.
 */
export function getLlmHealthStatus(): Record<string, { available: boolean; checkedAt: number }> {
  const status: Record<string, { available: boolean; checkedAt: number }> = {};
  for (const [origin, entry] of cache) {
    status[origin] = { available: entry.available, checkedAt: entry.checkedAt };
  }
  return status;
}

/**
 * Force a re-probe of all cached providers.
 * Called on startup or when a provider comes back online.
 */
export async function reprobeAll(): Promise<void> {
  const origins = [...cache.keys()];
  await Promise.all(origins.map(async (origin) => {
    const apiUrl = origin + '/v1/chat/completions';
    const authHeaders = getAuthHeaders(apiUrl);
    let available: boolean;
    if (Object.keys(authHeaders).length > 0) {
      const result = await probeAuth(apiUrl, authHeaders);
      available = result.ok;
    } else {
      try {
        await fetch(origin, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        available = true;
      } catch { available = false; }
    }
    cache.set(origin, { available, checkedAt: Date.now(), ttlMs: CACHE_TTL_MS });
  }));
}

/**
 * Warm the health cache on startup by probing configured providers.
 * Fire-and-forget — does not block the caller.
 */
export function warmHealthCache(): void {
  const providerUrls: string[] = [];

  const ollamaUrl = typeof process !== 'undefined'
    ? (process.env?.OLLAMA_API_URL || process.env?.LLM_API_URL)
    : undefined;
  if (ollamaUrl) providerUrls.push(ollamaUrl);

  if (typeof process !== 'undefined' && process.env?.GROQ_API_KEY) {
    providerUrls.push('https://api.groq.com/openai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.OPENROUTER_API_KEY) {
    providerUrls.push('https://openrouter.ai/api/v1/chat/completions');
  }

  for (const url of providerUrls) {
    void isProviderAvailable(url);
  }
}
