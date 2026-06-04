/**
 * Frontend service for the Connected MCP clients tab (plan 2026-05-10-001 U9).
 *
 * Two surfaces:
 *   - `listMcpClients()` — calls Convex `mcpProTokens.listProMcpTokens` (public
 *     query, requires Clerk auth via ctx.auth). Returns rows for the caller's
 *     userId. Sibling of `listApiKeys()` in services/api-keys.ts.
 *   - `revokeMcpClient(tokenId)` — POSTs `/api/user/mcp-revoke` so the edge
 *     handler can pair the Convex revoke with the negative-cache invalidation
 *     atomically. Calling the public Convex mutation directly from the
 *     browser would skip the cache-invalidation step.
 *   - `fetchMcpQuota()` — GETs `/api/user/mcp-quota` to display the daily
 *     usage counter. Reads the same Redis key as api/mcp.ts (single source
 *     of truth — no client-side enforcement, just display).
 */

import { getConvexClient, getConvexApi, waitForConvexAuth } from './convex-client';
import { getClerkToken } from './clerk';

export interface McpClientInfo {
  id: string;
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface McpQuota {
  used: number;
  limit: number;
  resetsAt: string;
}

/** List all Pro MCP tokens for the current user. */
export async function listMcpClients(): Promise<McpClientInfo[]> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) return [];

  await waitForConvexAuth();

  // Mirror services/api-keys.ts:listApiKeys cast pattern — the generated
  // Convex `api` is fully typed at module level but each service casts
  // `as any` at the call-site to avoid pulling the entire generated index
  // type into every service file.
  const rows = await client.query((api as any).mcpProTokens.listProMcpTokens, {});
  return rows as McpClientInfo[];
}

/**
 * Revoke a Pro MCP token by tokenId.
 *
 * Calls the edge endpoint (NOT the public Convex mutation directly) so the
 * negative-cache sentinel write is paired atomically with the Convex revoke.
 * Throws on non-2xx so the UI can surface the error.
 */
export async function revokeMcpClient(tokenId: string): Promise<void> {
  const token = await getClerkToken();
  if (!token) throw new Error('Sign in to revoke MCP clients.');

  const resp = await fetch('/api/user/mcp-revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tokenId }),
  });

  if (resp.ok) return;

  if (resp.status === 404) {
    throw new Error('This client was already revoked or no longer exists.');
  }
  if (resp.status === 409) {
    throw new Error('This client was already revoked.');
  }
  if (resp.status === 401) {
    throw new Error('Sign in to revoke MCP clients.');
  }
  if (resp.status === 503) {
    throw new Error('Revoke service is temporarily unavailable. Try again in a moment.');
  }
  throw new Error(`Revoke failed (HTTP ${resp.status}).`);
}

export interface McpLogEntry {
  t: string;   // ISO timestamp
  tool: string;
  s: string;   // "ok" | "error"
  ms: number;  // duration in ms
}

export interface McpCallLogPage {
  entries: McpLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Fetch one page of today's MCP call log. */
export async function fetchMcpCallLog(page = 1, pageSize = 20): Promise<McpCallLogPage> {
  const empty: McpCallLogPage = { entries: [], total: 0, page, pageSize };

  const token = await getClerkToken();
  if (!token) return empty;

  try {
    const resp = await fetch(`/api/user/mcp-logs?page=${page}&pageSize=${pageSize}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return empty;
    return (await resp.json()) as McpCallLogPage;
  } catch {
    return empty;
  }
}
