/**
 * SSE streaming wrapper for list-feed-digest.
 *
 * POST /api/news-feed-stream
 * Body: { variant?: string, lang?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"status":"cached","result":{...}}     — cache hit, instant
 *   data: {"status":"processing"}                — fetching RSS feeds
 *   data: {"status":"done","result":{...}}        — digest ready
 *   data: {"status":"error","message":"..."}      — on failure
 *
 * Cache hit (< 1s): most requests land here because digest is
 * cached for 900s. Cache miss: streams "processing" immediately
 * so the client knows work is happening.
 *
 * NOTE: Netlify Free has a 10s wall-clock limit. On cache miss the
 * full RSS fetch (~30s) will be killed. Use the seed-based
 * /api/news/v1/list-feed-digest (GET) for reliable access — it
 * reads from Redis pre-computed by the seed pipeline.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKeyWithUserKeys } from './_sse-auth.js';
import { listFeedDigest } from '../server/worldmonitor/news/v1/list-feed-digest';
import { getCachedJson } from '../server/_shared/redis';

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'commodity', 'happy', 'energy']);

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) return new Response('Forbidden', { status: 403 });
  const cors = getCorsHeaders(req, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  const keyResult = await validateApiKeyWithUserKeys(req);
  if (!keyResult.valid) {
    return new Response(JSON.stringify({ error: keyResult.error || 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let body: { variant?: unknown; lang?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const variant = typeof body.variant === 'string' && VALID_VARIANTS.has(body.variant) ? body.variant : 'full';
  const lang = typeof body.lang === 'string' ? body.lang : 'en';

  // Fast path: check cache directly — if hit, return immediately
  const digestCacheKey = `news:digest:v1:${variant}:${lang}`;
  const cached = await getCachedJson(digestCacheKey, true);
  if (cached) {
    return new Response(`data: ${JSON.stringify({ status: 'cached', result: cached })}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', ...cors },
    });
  }

  // Cache miss — stream: send "processing" immediately, then build digest
  const enc = new TextEncoder();
  const emit = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // First byte — keeps connection alive
        controller.enqueue(emit({ status: 'processing' }));

        const ctx = { request: req } as Parameters<typeof listFeedDigest>[0];
        const result = await listFeedDigest(ctx, { variant, lang });

        const totalItems = Object.values(result.categories).reduce((sum, b) => sum + b.items.length, 0);
        if (totalItems > 0) {
          controller.enqueue(emit({ status: 'done', result }));
        } else {
          controller.enqueue(emit({ status: 'error', message: 'No RSS data available' }));
        }
      } catch (err) {
        controller.enqueue(emit({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
      } finally {
        controller.close();
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
