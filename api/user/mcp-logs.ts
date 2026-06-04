/**
 * GET /api/user/mcp-logs?page=1&pageSize=20
 *
 * Clerk-authenticated endpoint that returns the caller's MCP call log
 * for today (UTC). Data is stored in Redis lists by api/mcp.ts
 * (key: mcp:call-log:<userId>:<YYYY-MM-DD>). Auto-expires after ~26h.
 *
 * Response: { entries: McpLogEntry[], total: number, page: number, pageSize: number }
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { resolveClerkSession } from '../../server/_shared/auth-session';

export interface McpLogEntry {
  t: string;   // ISO timestamp
  tool: string;
  s: string;   // "ok" | "error"
  ms: number;  // duration in ms
}

const REDIS_OP_TIMEOUT_MS = 2_000;

function mcpCallLogKey(userId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `mcp:call-log:${userId}:${y}-${m}-${d}`;
}

async function redisLRange(key: string, start: number, stop: number): Promise<string[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  const resp = await fetch(`${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: unknown };
  return Array.isArray(data?.result) ? data.result as string[] : [];
}

async function redisLLen(key: string): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 0;
  const resp = await fetch(`${url}/llen/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
  });
  if (!resp.ok) return 0;
  const data = (await resp.json()) as { result?: unknown };
  return typeof data?.result === 'number' ? data.result : 0;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { ...jsonHeaders, Allow: 'GET, OPTIONS' },
    });
  }

  const session = await resolveClerkSession(req);
  if (!session?.userId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: jsonHeaders });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));
  const now = new Date();
  const key = mcpCallLogKey(session.userId, now);

  let total = 0;
  let rawEntries: string[] = [];
  try {
    [total, rawEntries] = await Promise.all([
      redisLLen(key),
      redisLRange(key, (page - 1) * pageSize, page * pageSize - 1),
    ]);
  } catch (err) {
    console.warn('[mcp-logs] Redis read failed:', err instanceof Error ? err.message : String(err));
    captureSilentError(err, { tags: { route: 'api/user/mcp-logs', step: 'redis-read' } });
  }

  const entries: McpLogEntry[] = [];
  for (const raw of rawEntries) {
    try {
      entries.push(JSON.parse(raw) as McpLogEntry);
    } catch { /* skip malformed */ }
  }

  return new Response(
    JSON.stringify({ entries, total, page, pageSize }),
    { status: 200, headers: jsonHeaders },
  );
}
