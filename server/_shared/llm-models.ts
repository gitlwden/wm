// server/_shared/llm-models.ts
// Dynamic model discovery: fetches available models from /v1/models,
// probes each with max_tokens=1 to build a working-models whitelist.
// Caches results with configurable TTL + file persistence.

import type { LlmProviderName } from './llm';

// Conditional Node.js imports — not available in Edge Runtime
let fs: typeof import('fs') | null = null;
let path: typeof import('path') | null = null;
try {
  fs = require('fs');
  path = require('path');
} catch { /* Edge Runtime — file cache disabled */ }

const PROBE_TIMEOUT_MS = 5_000;
const DISCOVERY_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // re-discover every 4h
const DISCOVERY_STALE_TTL_MS = 30 * 60 * 1000; // on failure, retry in 30min

// File-based cache for persistence across restarts (Node.js only)
const MODEL_CACHE_DIR = path?.join(process.cwd(), '.cache') ?? '';
const MODEL_CACHE_FILE = path ? path.join(MODEL_CACHE_DIR, 'llm-models.json') : '';

interface ProviderConfig {
  url: string;          // base URL e.g. https://api.groq.com/openai/v1
  envKey: string;       // env var name for API key
}

const PROVIDERS: Record<LlmProviderName, ProviderConfig> = {
  groq:      { url: 'https://api.groq.com/openai/v1',       envKey: 'GROQ_API_KEY' },
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

interface ModelCacheEntry {
  provider: string;
  models: string[];
  discoveredAt: number;
  latencyMs?: number;
}

// In-memory cache (fast access)
const discoveryCache = new Map<LlmProviderName, DiscoveredModels>();
const inFlight = new Map<LlmProviderName, Promise<string[]>>();

// File cache state
let fileCacheLoaded = false;
let fileCache: Record<string, ModelCacheEntry> = {};

function getApiKey(envKey: string): string | undefined {
  return process.env[envKey];
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs) return;
  try {
    if (!fs.existsSync(MODEL_CACHE_DIR)) {
      fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    }
  } catch { /* ignore */ }
}

/**
 * Load model cache from file
 */
function loadFileCache(): Record<string, ModelCacheEntry> {
  if (fileCacheLoaded) return fileCache;
  if (!fs) { fileCacheLoaded = true; return fileCache; }

  try {
    ensureCacheDir();
    if (fs.existsSync(MODEL_CACHE_FILE)) {
      const data = fs.readFileSync(MODEL_CACHE_FILE, 'utf8');
      fileCache = JSON.parse(data);
      fileCacheLoaded = true;
      console.log(`[llm-models] Loaded file cache with ${Object.keys(fileCache).length} providers`);
    }
  } catch (err) {
    console.warn('[llm-models] Failed to load file cache:', (err as Error).message);
  }

  fileCacheLoaded = true;
  return fileCache;
}

/**
 * Save model cache to file
 */
function saveFileCache(): void {
  if (!fs) return;
  try {
    ensureCacheDir();
    fs.writeFileSync(MODEL_CACHE_FILE, JSON.stringify(fileCache, null, 2));
  } catch (err) {
    console.warn('[llm-models] Failed to save file cache:', (err as Error).message);
  }
}

/**
 * Get cached models for a provider (from file cache if valid)
 */
function getFileCachedModels(provider: LlmProviderName): string[] | null {
  const cache = loadFileCache();
  const entry = cache[provider];

  if (!entry) return null;

  // Check if cache is still valid
  const age = Date.now() - entry.discoveredAt;
  if (age > DISCOVERY_CACHE_TTL_MS) {
    return null; // expired
  }

  return entry.models.length > 0 ? entry.models : null;
}

/**
 * Update file cache for a provider
 */
function updateFileCache(provider: LlmProviderName, models: string[], latencyMs?: number): void {
  const cache = loadFileCache();
  cache[provider] = {
    provider,
    models,
    discoveredAt: Date.now(),
    latencyMs,
  };
  saveFileCache();
}

/**
 * Fetch the model list from /v1/models, then probe each one.
 * Returns only models that responded successfully.
 */
async function discoverModels(provider: LlmProviderName): Promise<string[]> {
  const config = PROVIDERS[provider];
  if (!config) return [];
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
  const start = Date.now();
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

  const latencyMs = Date.now() - start;

  // Update file cache
  if (working.length > 0) {
    updateFileCache(provider, working, latencyMs);
    console.log(`[llm-models:${provider}] Discovered ${working.length} models in ${latencyMs}ms: ${working.join(', ')}`);
  }

  return working;
}

/**
 * Get available models for a provider.
 * Returns cached list if fresh (memory or file), otherwise discovers and caches.
 */
export async function getAvailableModels(provider: LlmProviderName): Promise<string[]> {
  // Check memory cache first (fastest)
  const cached = discoveryCache.get(provider);
  if (cached && Date.now() - cached.discoveredAt < cached.ttlMs) {
    return cached.models;
  }

  // Check if another call is already discovering
  const existing = inFlight.get(provider);
  if (existing) return existing;

  const promise = (async () => {
    // Check file cache before doing expensive discovery
    const fileCached = getFileCachedModels(provider);
    if (fileCached) {
      console.log(`[llm-models:${provider}] Using file-cached ${fileCached.length} models`);
      // Update memory cache from file
      discoveryCache.set(provider, {
        models: fileCached,
        discoveredAt: Date.now(),
        ttlMs: DISCOVERY_CACHE_TTL_MS,
      });
      return fileCached;
    }

    // Run full discovery
    const models = await discoverModels(provider);
    const ttlMs = models.length > 0 ? DISCOVERY_CACHE_TTL_MS : DISCOVERY_STALE_TTL_MS;
    discoveryCache.set(provider, { models, discoveredAt: Date.now(), ttlMs });
    inFlight.delete(provider);

    if (models.length === 0) {
      console.warn(`[llm-models:${provider}] No working models found`);
    }

    return models;
  })();

  inFlight.set(provider, promise);
  return promise;
}

/**
 * Get cache status for all providers
 */
export function getModelCacheStatus(): Record<string, {
  memoryCached: boolean;
  fileCached: boolean;
  modelCount: number;
  lastTested?: string;
}> {
  const fileCacheData = loadFileCache();
  const status: Record<string, { memoryCached: boolean; fileCached: boolean; modelCount: number; lastTested?: string }> = {};

  for (const provider of Object.keys(PROVIDERS) as LlmProviderName[]) {
    const memCache = discoveryCache.get(provider);
    const fileEntry = fileCacheData[provider];

    status[provider] = {
      memoryCached: !!memCache,
      fileCached: !!fileEntry,
      modelCount: memCache?.models?.length || fileEntry?.models?.length || 0,
      lastTested: fileEntry?.discoveredAt
        ? new Date(fileEntry.discoveredAt).toISOString()
        : undefined,
    };
  }

  return status;
}

/**
 * Force re-discovery for a provider (invalidates both caches)
 */
export async function rediscoverModels(provider: LlmProviderName): Promise<string[]> {
  // Clear memory cache
  discoveryCache.delete(provider);

  // Clear file cache entry
  const cache = loadFileCache();
  delete cache[provider];
  saveFileCache();

  // Run fresh discovery
  return getAvailableModels(provider);
}

/**
 * Warm the discovery cache on startup. Fire-and-forget.
 * Checks file cache first to avoid unnecessary API calls.
 */
export function warmModelDiscovery(): void {
  for (const provider of Object.keys(PROVIDERS) as LlmProviderName[]) {
    const config = PROVIDERS[provider];
    if (getApiKey(config.envKey)) {
      // This will check file cache first, only discover if needed
      void getAvailableModels(provider);
    }
  }
}
