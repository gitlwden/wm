/**
 * SSE streaming wrapper for deduct-situation.
 *
 * POST /api/deduct-situation-stream
 * Body: { query: string, geoContext?: string, framework?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"status":"cached","result":{...}}     — cache hit, instant
 *   data: {"status":"processing"}                — LLM working (keeps connection alive)
 *   data: {"status":"done","result":{...}}        — LLM result ready
 *   data: {"status":"error","message":"..."}      — on failure
 *
 * Uses ReadableStream so the first byte is sent immediately — Netlify
 * sees an active response and won't kill the function at the 10s wall.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKeyWithUserKeys } from './_sse-auth.js';
import { deductSituation } from '../server/worldmonitor/intelligence/v1/deduct-situation';
import type { DeductSituationResponse } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../server/_shared/redis';
import { sha256Hex } from '../server/worldmonitor/intelligence/v1/_shared';

const MAX_QUERY_LEN = 500;

function streamSSE(cors: Record<string, string>, producer: (emit: (obj: Record<string, unknown>) => void) => Promise<void>) {
  const enc = new TextEncoder();
  const emit = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      controller = ctrl;
      try {
        await producer((obj) => ctrl.enqueue(emit(obj)));
      } catch (err) {
        ctrl.enqueue(emit({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
      } finally {
        ctrl.close();
      }
    },
  });

  return new Response(stream, {
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

  // Auth — supports both enterprise keys and wm_ user keys
  const keyResult = await validateApiKeyWithUserKeys(req);
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
    return new Response(JSON.stringify({ status: 'error', message: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_LEN) : '';
  if (!query) return new Response(JSON.stringify({ status: 'error', message: 'query is required' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

  const geoContext = typeof body.geoContext === 'string' ? body.geoContext.trim() : '';
  const framework = typeof body.framework === 'string' ? body.framework.trim() : '';

  // Check cache directly (same key logic as deduct-situation.ts)
  const queryHash = await sha256Hex(query.toLowerCase() + '|' + geoContext.toLowerCase());
  const cacheKey = `deduct:situation:v2:${queryHash.slice(0, 16)}`;
  const cachedRaw = await getCachedJson(cacheKey, true);
  const cached = cachedRaw as DeductSituationResponse | null;

  if (cached?.analysis) {
    // Cache hit — return immediately without streaming
    return new Response(`data: ${JSON.stringify({ status: 'cached', result: cached })}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', ...cors },
    });
  }

  // Cache miss — stream: send "processing" immediately to keep Netlify alive,
  // then call LLM and send result when ready.
  return streamSSE(cors, async (emit) => {
    emit({ status: 'processing' });

    const ctx = { request: req } as Parameters<typeof deductSituation>[0];
    const result = await deductSituation(ctx, { query, geoContext, framework });

    if (result?.analysis) {
      emit({ status: 'done', result });
    } else {
      emit({ status: 'error', message: 'LLM providers unavailable' });
    }
  });
}
