// server/_shared/llm-models.ts
// Dynamic model discovery: fetches available models from /v1/models,
// probes each with max_tokens=1 to build a working-models whitelist.
// Caches results with configurable TTL.

import type { LlmProviderName } from './llm';

const PROBE_TIMEOUT_MS = 5_000;
const DISCOVERY_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // re-discover every 4h
const DISCOVERY_STALE_TTL_MS = 30 * 60 * 1000; // on failure, retry in 30min

interface ProviderConfig {
  url: string;          // base URL e.g. https://api.groq.com/openai/v1
  envKey: string;       // env var name for API key
}

const PROVIDERS: Record<LlmProviderName, ProviderConfig> = {
  nvidia:    { url: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_NIM_API_KEY' },
  cerebras:  { url: 'https://api.cerebras.ai/v1',          envKey: 'CEREBRAS_API_KEY' },
  sambanova: { url: 'https://api.sambanova.ai/v1',         envKey: 'SAMBANOVA_API_KEY' },
};

// Models to skip during auto-discovery (not useful for chat/summarization)
const MODEL_BLOCKLIST = new Set([
  'whisper-large-v3', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en',
  'llama-guard-3-8b', 'llama-guard-4-12b',
  'gemma-3-1b-it', // too small for useful output
]);

interface DiscoveredModels {
  models: string[];
  discoveredAt: number;
  ttlMs: number;
}

const discoveryCache = new Map<LlmProviderName, DiscoveredModels>();
const inFlight = new Map<LlmProviderName, Promise<string[]>>();

function getApiKey(envKey: string): string | undefined {
  return process.env[envKey];
}

/**
 * Fetch the model list from /v1/models, then probe each one.
 * Returns only models that responded successfully.
 */
async function discoverModels(provider: LlmProviderName): Promise<string[]> {
  const config = PROVIDERS[provider];
  const apiKey = getApiKey(config.envKey);
  if (!apiKey) return [];

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Step 1: get model list
  let modelIds: string[];
  try {
    const resp = await fetch(`${config.url}/models`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[llm-models:${provider}] /models HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json() as { data?: Array<{ id: string }> };
    modelIds = (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => !MODEL_BLOCKLIST.has(id));
  } catch (err) {
    console.warn(`[llm-models:${provider}] /models failed: ${(err as Error).message}`);
    return [];
  }

  if (modelIds.length === 0) return [];

  // Step 2: probe each model concurrently (max 3 at a time)
  const working: string[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < modelIds.length; i += CONCURRENCY) {
    const batch = modelIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (model) => {
      try {
        const resp = await fetch(`${config.url}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (resp.ok) return model;
        // 429 = rate limited but model exists — include it
        if (resp.status === 429) return model;
        return null;
      } catch {
        return null;
      }
    }));
    for (const m of results) {
      if (m) working.push(m);
    }
  }

  return working;
}

/**
 * Get available models for a provider.
 * Returns cached list if fresh, otherwise discovers and caches.
 */
export async function getAvailableModels(provider: LlmProviderName): Promise<string[]> {
  const cached = discoveryCache.get(provider);
  if (cached && Date.now() - cached.discoveredAt < cached.ttlMs) {
    return cached.models;
  }

  const existing = inFlight.get(provider);
  if (existing) return existing;

  const promise = (async () => {
    const models = await discoverModels(provider);
    const ttlMs = models.length > 0 ? DISCOVERY_CACHE_TTL_MS : DISCOVERY_STALE_TTL_MS;
    discoveryCache.set(provider, { models, discoveredAt: Date.now(), ttlMs });
    inFlight.delete(provider);
    if (models.length > 0) {
      console.log(`[llm-models:${provider}] Discovered ${models.length} working models: ${models.join(', ')}`);
    } else {
      console.warn(`[llm-models:${provider}] No working models found`);
    }
    return models;
  })();
  inFlight.set(provider, promise);
  return promise;
}

/**
 * Warm the discovery cache on startup. Fire-and-forget.
 */
export function warmModelDiscovery(): void {
  for (const provider of Object.keys(PROVIDERS) as LlmProviderName[]) {
    const config = PROVIDERS[provider];
    if (getApiKey(config.envKey)) {
      void getAvailableModels(provider);
    }
  }
}
