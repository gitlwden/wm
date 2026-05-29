import { CHROME_UA } from './constants';
import { isProviderAvailable } from './llm-health';
import { sanitizeForPrompt } from './llm-sanitize.js';

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export type LlmProviderName = 'groq' | 'openrouter' | 'nvidia';

/** Candidate models per provider. First is default, rest are fallbacks tried in order. */
const PROVIDER_MODELS: Record<LlmProviderName, string[]> = {
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
  ],
  openrouter: [
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct',
    'mistralai/mistral-small-3.1-24b-instruct',
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-8b-instruct',
    'mistralai/mixtral-8x22b-instruct',
  ],
};

const PROVIDER_APIS: Record<LlmProviderName, { url: string; envKey: string }> = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', envKey: 'NVIDIA_NIM_API_KEY' },
};

export function getProviderCredentials(
  provider: string,
  overrides: { model?: string } = {},
): ProviderCredentials | null {
  const meta = PROVIDER_APIS[provider as LlmProviderName];
  if (!meta) return null;

  const apiKey = process.env[meta.envKey];
  if (!apiKey) return null;

  const model = overrides.model || process.env[`${meta.envKey.replace('_API_KEY', '')}_MODEL`] || PROVIDER_MODELS[provider as LlmProviderName][0];

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://worldmonitor.app';
    headers['X-Title'] = 'World Monitor';
  }

  return { apiUrl: meta.url, model, headers };
}

export function stripThinkingTags(text: string): string {
  let s = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();

  // Strip unterminated opening tags (no closing tag present)
  s = s
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\|thinking\|>[\s\S]*/gi, '')
    .replace(/<reasoning>[\s\S]*/gi, '')
    .replace(/<reflection>[\s\S]*/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
    .trim();

  return s;
}


const PROVIDER_CHAIN: LlmProviderName[] = ['groq', 'openrouter', 'nvidia'];
const PROVIDER_SET = new Set<string>(PROVIDER_CHAIN);

export interface LlmCallOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: string;
  providerOrder?: string[];
  modelOverrides?: Partial<Record<LlmProviderName, string>>;
  stripThinkingTags?: boolean;
  validate?: (content: string) => boolean;
  systemAppend?: string;
}

export interface LlmCallResult {
  content: string;
  model: string;
  provider: string;
  tokens: number;
}

function resolveProviderChain(opts: {
  forcedProvider?: string;
  providerOrder?: string[];
}): LlmProviderName[] {
  if (opts.forcedProvider) return [opts.forcedProvider as LlmProviderName];
  if (!Array.isArray(opts.providerOrder) || opts.providerOrder.length === 0) {
    return [...PROVIDER_CHAIN];
  }

  const seen = new Set<string>();
  const providers: LlmProviderName[] = [];
  for (const provider of opts.providerOrder) {
    if (!PROVIDER_SET.has(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider as LlmProviderName);
  }

  return providers.length > 0 ? providers : [...PROVIDER_CHAIN];
}

function callLlmProfile(
  opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>,
  providerEnv: string,
  modelEnv: string,
  defaultProvider: LlmProviderName,
): Promise<LlmCallResult | null> {
  const envProvider = process.env[providerEnv];
  const provider = (envProvider && PROVIDER_SET.has(envProvider) ? envProvider : (() => {
    if (envProvider) console.warn(`[llm] ${providerEnv}="${envProvider}" is not a known provider; falling back to "${defaultProvider}"`);
    return defaultProvider;
  })()) as LlmProviderName;
  const model = process.env[modelEnv];
  const remaining = PROVIDER_CHAIN.filter((p) => p !== provider);
  return callLlm({
    ...opts,
    providerOrder: [provider, ...remaining],
    modelOverrides: model ? { [provider]: model } as Partial<Record<LlmProviderName, string>> : undefined,
  });
}

/** Cheap/fast model for extraction and parsing tasks. Configurable via LLM_TOOL_PROVIDER / LLM_TOOL_MODEL. */
export const callLlmTool = (opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>) =>
  callLlmProfile(opts, 'LLM_TOOL_PROVIDER', 'LLM_TOOL_MODEL', 'groq');

/** Powerful model for synthesis and reasoning tasks. Configurable via LLM_REASONING_PROVIDER / LLM_REASONING_MODEL. */
export const callLlmReasoning = (opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>) =>
  callLlmProfile(opts, 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL', 'groq');

export type LlmStreamOptions = Omit<LlmCallOptions, 'stripThinkingTags' | 'validate' | 'providerOrder' | 'modelOverrides' | 'provider'> & {
  /** When fired, aborts the active provider fetch and stops the stream. */
  signal?: AbortSignal;
};

/**
 * Streaming variant of callLlmReasoning.
 * Returns a ReadableStream that emits SSE lines:
 *   data: {"delta":"..."}  — one per content chunk
 *   data: {"done":true}    — terminal event
 * Returns null if no provider is available.
 */
export function callLlmReasoningStream(opts: LlmStreamOptions): ReadableStream<Uint8Array> {
  const envProvider = process.env.LLM_REASONING_PROVIDER;
  const provider = (envProvider && PROVIDER_SET.has(envProvider) ? envProvider : 'groq') as LlmProviderName;
  const modelOverride = process.env.LLM_REASONING_MODEL;
  const remaining = PROVIDER_CHAIN.filter((p) => p !== provider);
  const providerOrder = [provider, ...remaining];

  const {
    messages: rawMessages,
    temperature = 0.3,
    maxTokens = 600,
    timeoutMs = 90_000,
    systemAppend,
    signal: clientSignal,
  } = opts;

  let messages = rawMessages;
  const firstMsg = messages[0];
  if (systemAppend && firstMsg?.role === 'system') {
    const sanitized = sanitizeForPrompt(systemAppend);
    if (sanitized) {
      messages = [
        { role: 'system', content: `${firstMsg.content}\n\n---\n\n${sanitized}` },
        ...messages.slice(1),
      ];
    }
  }

  const enc = new TextEncoder();
  let activeController: AbortController | null = null;
  let streamClosed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        if (streamClosed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        controller.close();
      };

      for (const providerName of providerOrder) {
        if (streamClosed) break;

        const meta = PROVIDER_APIS[providerName as LlmProviderName];
        if (meta && !(await isProviderAvailable(meta.url))) {
          console.warn(`[llm-stream:${providerName}] Offline, skipping`);
          continue;
        }

        const models = modelOverride
          ? [modelOverride]
          : PROVIDER_MODELS[providerName as LlmProviderName] || [];

        for (const model of models) {
          if (streamClosed) break;

          const creds = getProviderCredentials(providerName, { model });
          if (!creds) break;

          // Per-fetch abort controller merges client signal + per-request timeout
          activeController = new AbortController();
          const timeoutId = setTimeout(() => activeController?.abort(), timeoutMs);
          if (clientSignal?.aborted) { clearTimeout(timeoutId); break; }
          clientSignal?.addEventListener('abort', () => activeController?.abort(), { once: true });

          let hasContent = false;
          try {
            const resp = await fetch(creds.apiUrl, {
              method: 'POST',
              headers: { ...creds.headers, 'User-Agent': CHROME_UA },
              body: JSON.stringify({
                model: creds.model,
                messages,
                temperature,
                max_tokens: maxTokens,
                stream: true,
              }),
              signal: activeController.signal,
            });

            if (!resp.ok || !resp.body) {
              clearTimeout(timeoutId);
              const errBody = resp.body ? await resp.text().catch(() => '') : '';
              const status = resp.status;
              if (status === 401 || status === 403 || status === 402) {
                console.warn(`[llm-stream:${providerName}:${model}] HTTP ${status} — skipping provider`);
                break;
              }
              console.warn(`[llm-stream:${providerName}:${model}] HTTP ${status} — trying next model`);
              continue;
            }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let providerDone = false;

          while (!streamClosed && !providerDone) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') { providerDone = true; break; }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
                };
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  hasContent = true;
                  emit({ delta });
                }
              } catch { /* malformed chunk — skip */ }
            }
          }
          clearTimeout(timeoutId);

          if (hasContent) {
            emit({ done: true });
            closeStream();
            return;
          }
        } catch (err) {
          clearTimeout(timeoutId);
          if (hasContent) {
            closeStream();
            return;
          }
          if (streamClosed) return;
          console.warn(`[llm-stream:${providerName}:${model}] ${(err as Error).message}`);
        }
        } // model loop
        } // provider loop

      if (!streamClosed) {
        emit({ error: 'llm_unavailable' });
        closeStream();
      }
    },
    cancel() {
      // Client disconnected — abort the active provider fetch immediately
      streamClosed = true;
      activeController?.abort();
    },
  });
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult | null> {
  const {
    messages: rawMessages,
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 25_000,
    provider: forcedProvider,
    providerOrder,
    modelOverrides,
    stripThinkingTags: shouldStrip = true,
    validate,
    systemAppend,
  } = opts;

  let messages = rawMessages;
  const firstMsg = messages[0];
  if (systemAppend && firstMsg && firstMsg.role === 'system') {
    const sanitized = sanitizeForPrompt(systemAppend);
    if (sanitized) {
      messages = [
        { role: 'system', content: `${firstMsg.content}\n\n---\n\n${sanitized}` },
        ...messages.slice(1),
      ];
    }
  }

  const providers = resolveProviderChain({ forcedProvider, providerOrder });

  for (const providerName of providers) {
    // Health gate: skip provider if auth/connectivity failed
    const meta = PROVIDER_APIS[providerName];
    if (meta && !(await isProviderAvailable(meta.url))) {
      console.warn(`[llm:${providerName}] Offline, skipping`);
      if (forcedProvider) return null;
      continue;
    }

    // Build model list: explicit override first, then provider's candidate list
    const overrideModel = modelOverrides?.[providerName];
    const models = overrideModel
      ? [overrideModel]
      : PROVIDER_MODELS[providerName];

    for (const model of models) {
      const creds = getProviderCredentials(providerName, { model });
      if (!creds) break;

      try {
        const resp = await fetch(creds.apiUrl, {
          method: 'POST',
          headers: { ...creds.headers, 'User-Agent': CHROME_UA },
          body: JSON.stringify({
            model: creds.model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          const status = resp.status;
          // Auth/credits error → skip entire provider (all models will fail)
          if (status === 401 || status === 403 || status === 402) {
            console.warn(`[llm:${providerName}:${model}] HTTP ${status} — skipping provider`);
            break;
          }
          // Model-specific error (404, 429) → try next model
          console.warn(`[llm:${providerName}:${model}] HTTP ${status} — trying next model`);
          continue;
        }

        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };

        let content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
          console.warn(`[llm:${providerName}:${model}] empty response — trying next model`);
          continue;
        }

        const tokens = data.usage?.total_tokens ?? 0;

        if (shouldStrip) {
          content = stripThinkingTags(content);
          if (!content) continue;
        }

        content = content.replace(/^```(?:\w+)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

        if (validate && !validate(content)) {
          console.warn(`[llm:${providerName}:${model}] validate() rejected — trying next model`);
          continue;
        }

        return { content, model: creds.model, provider: providerName, tokens };
      } catch (err) {
        console.warn(`[llm:${providerName}:${model}] ${(err as Error).message}`);
        // Network error → try next model
      }
    }
    if (forcedProvider) return null;
  }

  return null;
}
