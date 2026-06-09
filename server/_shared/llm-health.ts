// server/_shared/llm-health.ts
// Lightweight LLM provider health gate.
// Probes provider URLs with a fast request, caches results.
// All LLM call sites check this before attempting expensive fetch calls.

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000; // re-probe every 60s
const AUTH_FAIL_TTL_MS = 5 * 60_000; // auth errors: re-probe after 5min

interface HealthEntry {
  available: boolean;
  checkedAt: number;
  ttlMs: number;
}

const cache = new Map<string, HealthEntry>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Probe a provider by hitting its /models endpoint with auth.
 * GET /v1/models is lightweight and verifies both reachability + API key.
 */
async function probe(url: string, headers: Record<string, string>): Promise<{ ok: boolean; statusCode: number }> {
  try {
    // /models endpoint — lightweight, no token consumption
    const modelsUrl = url.replace(/\/chat\/completions$/, '/models');
    const resp = await fetch(modelsUrl, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: resp.status < 401, statusCode: resp.status };
  } catch {
    return { ok: false, statusCode: 0 };
  }
}

function getAuthHeaders(url: string): Record<string, string> {
  const origin = new URL(url).origin;
  if (origin === 'https://api.groq.com') {
    const key = process.env.GROQ_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  if (origin === 'https://integrate.api.nvidia.com') {
    const key = process.env.NVIDIA_NIM_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  if (origin === 'https://api.cerebras.ai') {
    const key = process.env.CEREBRAS_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  if (origin === 'https://api.sambanova.ai') {
    const key = process.env.SAMBANOVA_API_KEY;
    if (key) return { Authorization: `Bearer ${key}` };
  }
  return {};
}

/**
 * Check if an LLM provider endpoint is available.
 * Returns cached result if fresh (< entry.ttlMs old).
 * Probes /models with auth key to verify both reachability and API key validity.
 */
export async function isProviderAvailable(apiUrl: string): Promise<boolean> {
  const origin = new URL(apiUrl).origin;
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.checkedAt < cached.ttlMs) {
    return cached.available;
  }

  const existing = inFlight.get(origin);
  if (existing) return existing;

  const promise = (async () => {
    const authHeaders = getAuthHeaders(apiUrl);
    const result = await probe(apiUrl, authHeaders);
    const available = result.ok;
    const ttlMs = (!available && result.statusCode >= 401 && result.statusCode <= 403)
      ? AUTH_FAIL_TTL_MS
      : CACHE_TTL_MS;

    if (!available) {
      const label = result.statusCode >= 401 && result.statusCode <= 403
        ? `Auth failed (HTTP ${result.statusCode})`
        : 'Unreachable';
      console.warn(`[llm-health] ${label}: ${origin} — retry in ${ttlMs / 1000}s`);
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
    const result = await probe(apiUrl, authHeaders);
    cache.set(origin, { available: result.ok, checkedAt: Date.now(), ttlMs: CACHE_TTL_MS });
  }));
}

/**
 * Warm the health cache on startup by probing configured providers.
 * Fire-and-forget — does not block the caller.
 */
export function warmHealthCache(): void {
  const providerUrls: string[] = [];

  if (typeof process !== 'undefined' && process.env?.GROQ_API_KEY) {
    providerUrls.push('https://api.groq.com/openai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.NVIDIA_NIM_API_KEY) {
    providerUrls.push('https://integrate.api.nvidia.com/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.CEREBRAS_API_KEY) {
    providerUrls.push('https://api.cerebras.ai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.SAMBANOVA_API_KEY) {
    providerUrls.push('https://api.sambanova.ai/v1/chat/completions');
  }

  for (const url of providerUrls) {
    void isProviderAvailable(url);
  }
}
