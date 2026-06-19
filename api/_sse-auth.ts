/**
 * Auth helper for standalone SSE/edge handlers that bypass the gateway.
 *
 * The gateway (server/gateway.ts) has a two-step auth flow:
 *   1. validateApiKey — static key check (WORLDMONITOR_VALID_KEYS)
 *   2. validateUserApiKey — Convex-backed wm_ key check (fallback)
 *
 * Standalone handlers (deduct-situation-stream, news-feed-stream) call
 * validateApiKey directly and miss the wm_ fallback. This helper
 * replicates the gateway's two-step flow so SSE endpoints accept
 * both enterprise keys and user keys.
 */

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
import { validateUserApiKey } from '../server/_shared/user-api-key';

export async function validateApiKeyWithUserKeys(request: Request): Promise<{ valid: boolean; error?: string }> {
  const keyResult = await validateApiKey(request) as { valid: boolean; required: boolean; error?: string };

  // Enterprise key (WORLDMONITOR_VALID_KEYS) — accepted
  if (keyResult.valid) return { valid: true };

  // wm_ user key — try Convex-backed validation
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';
  if (wmKey.startsWith('wm_')) {
    const userKey = await validateUserApiKey(wmKey);
    if (userKey) return { valid: true };
  }

  return { valid: false, error: keyResult.error || 'Unauthorized' };
}
