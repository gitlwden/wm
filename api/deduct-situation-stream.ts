/**
 * SSE streaming wrapper for deduct-situation.
 *
 * POST /api/deduct-situation-stream
 * Body: { query: string, geoContext?: string, framework?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"status":"cached","result":{...}}     — cache hit, instant
 *   data: {"status":"done","result":{...}}        — LLM result ready
 *   data: {"status":"error","message":"..."}      — on failure
 *
 * The underlying deductSituation uses fast-inference providers (Groq,
 * Cerebras, SambaNova) with a 20 s timeout.  SSE lets the client see
 * cache hits instantly and know the LLM is working on misses.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { deductSituation } from '../server/worldmonitor/intelligence/v1/deduct-situation';
import type { DeductSituationResponse } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../server/_shared/redis';
import { sha256Hex } from '../server/worldmonitor/intelligence/v1/_shared';

const MAX_QUERY_LEN = 500;

function sseResponse(events: Record<string, unknown>[], cors: Record<string, string>) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...cors,
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) return new Response('Forbidden', { status: 403 });
  const cors = getCorsHeaders(req, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  // Auth — same as gateway
  const keyResult = await validateApiKey(req);
  if (!keyResult.valid) {
    return new Response(JSON.stringify({ error: keyResult.error || 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let body: { query?: unknown; geoContext?: unknown; framework?: unknown };
  try {
    body = await req.json();
  } catch {
    return sseResponse([{ status: 'error', message: 'Invalid JSON body' }], cors);
  }

  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_LEN) : '';
  if (!query) return sseResponse([{ status: 'error', message: 'query is required' }], cors);

  const geoContext = typeof body.geoContext === 'string' ? body.geoContext.trim() : '';
  const framework = typeof body.framework === 'string' ? body.framework.trim() : '';

  // Check cache directly (same key logic as deduct-situation.ts)
  const queryHash = await sha256Hex(query.toLowerCase() + '|' + geoContext.toLowerCase());
  const cacheKey = `deduct:situation:v2:${queryHash.slice(0, 16)}`;
  const cachedRaw = await getCachedJson(cacheKey, true);
  const cached = cachedRaw as DeductSituationResponse | null;

  if (cached?.analysis) {
    return sseResponse([{ status: 'cached', result: cached }], cors);
  }

  // Cache miss — call LLM via deductSituation (uses fast providers, 20s timeout)
  try {
    const ctx = { request: req } as Parameters<typeof deductSituation>[0];
    const result = await deductSituation(ctx, { query, geoContext, framework });

    if (result?.analysis) {
      return sseResponse([{ status: 'done', result }], cors);
    }
    return sseResponse([{ status: 'error', message: 'LLM providers unavailable' }], cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sseResponse([{ status: 'error', message: msg }], cors);
  }
}
