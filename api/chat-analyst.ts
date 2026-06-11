/**
 * Streaming chat analyst edge function — Pro only.
 *
 * POST /api/chat-analyst
 * Body: { history: {role,content}[], query: string, domainFocus?: string, geoContext?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"meta":{"sources":["Brief","Risk",...],"degraded":false}}  — always first event
 *   data: {"action":{"type":"suggest-widget","label":"...","prefill":"..."}}  — optional, visual queries only
 *   data: {"delta":"..."}    — one per content token
 *   data: {"done":true}      — terminal event
 *   data: {"error":"..."}    — on auth/llm failure
 */

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
import { isCallerPremium } from '../server/_shared/premium-check';
import { checkRateLimit } from '../server/_shared/rate-limit';
import { assembleAnalystContext } from '../server/worldmonitor/intelligence/v1/chat-analyst-context';
import { buildAnalystSystemPrompt } from '../server/worldmonitor/intelligence/v1/chat-analyst-prompt';
import { buildActionEvents } from '../server/worldmonitor/intelligence/v1/chat-analyst-actions';
import { callLlm } from '../server/_shared/llm';
import { sanitizeForPrompt } from '../server/_shared/llm-sanitize.js';

const MAX_QUERY_LEN = 500;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 800;
const MAX_GEO_LEN = 2;
const VALID_DOMAINS = new Set(['all', 'geo', 'market', 'military', 'economic']);

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatAnalystRequestBody {
  history?: unknown[];
  query?: unknown;
  domainFocus?: unknown;
  geoContext?: unknown;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // Premium check is informational only — not a hard gate.
  // Server-side LLM keys (Groq/OpenRouter) are funded by the operator,
  // same pattern as /api/intelligence/v1/deduct-situation.
  const _isPremium = await isCallerPremium(req);

  // Streaming LLM endpoint — the rate-limit IS the abuse defence (each
  // call hits a frontier model). This route doesn't go through gateway
  // checkEndpointRateLimit, so opt into fail-closed explicitly: a Redis
  // outage must not silently lift the budget. (#3531)
  const rateLimitResponse = await checkRateLimit(req, corsHeaders, { failClosed: true });
  if (rateLimitResponse) return rateLimitResponse;

  let body: ChatAnalystRequestBody;
  try {
    body = (await req.json()) as ChatAnalystRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const rawQuery = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_LEN) : '';
  if (!rawQuery) return json({ error: 'query is required' }, 400, corsHeaders);

  const query = sanitizeForPrompt(rawQuery);
  if (!query) return json({ error: 'query is required' }, 400, corsHeaders);

  // Validate domainFocus against the fixed domain set to prevent prompt injection
  const rawDomain = typeof body.domainFocus === 'string' ? body.domainFocus.trim() : '';
  const domainFocus = VALID_DOMAINS.has(rawDomain) ? rawDomain : 'all';

  const geoContext = typeof body.geoContext === 'string'
    ? body.geoContext.trim().toUpperCase().slice(0, MAX_GEO_LEN)
    : undefined;

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: ChatMessage[] = rawHistory
    .filter((m): m is ChatMessage => {
      if (!m || typeof m !== 'object') return false;
      const msg = m as Record<string, unknown>;
      return (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string';
    })
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => {
      const sanitized = sanitizeForPrompt(m.content.slice(0, MAX_MESSAGE_CHARS)) ?? '';
      return { role: m.role, content: sanitized };
    })
    .filter((m) => m.content.length > 0);

  // Build retrieval query with current turn FIRST so its keywords fill the
  // extraction cap before prior-turn terms. This ensures pivot words like
  // "Germany" in "What about Germany?" are never crowded out by a long
  // previous question. Prior turn backfills remaining slots for topic continuity.
  const prevUserTurn = history.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '';
  const retrievalQuery = prevUserTurn ? `${query} ${prevUserTurn}` : query;

  const context = await assembleAnalystContext(geoContext, domainFocus, retrievalQuery);
  const systemPrompt = buildAnalystSystemPrompt(context, domainFocus);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: query },
  ];

  // Non-streaming LLM call — Netlify Functions don't reliably support
  // long-lived streaming responses (the ReadableStream stalls). Collect
  // the full response then send it as a single SSE delta event.
  let llmResult = null;
  try {
    llmResult = await callLlm({
      messages,
      maxTokens: 600,
      temperature: 0.35,
      timeoutMs: 25_000,
      providerOrder: ['groq', 'nvidia', 'cerebras', 'sambanova'],
    });
  } catch (err) {
    console.error('[chat-analyst] LLM call failed:', (err as Error).message);
  }

  const ssePayload = [
    { meta: { sources: context.activeSources, degraded: context.degraded } },
    ...buildActionEvents(query).map((a) => ({ action: a })),
    ...(llmResult
      ? [{ delta: llmResult.content }, { done: true }]
      : [{ error: 'llm_unavailable' }]),
  ];

  const sseBody = ssePayload.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

  return new Response(sseBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    },
  });
}
