const PUBLIC_BASE = (process.env.WORLDMONITOR_PUBLIC_BASE_URL || 'https://wm-worldmonitor.netlify.app').replace(/\/+$/, '');
const PUBLIC_HOST = new URL(PUBLIC_BASE).hostname;

const ALLOWED_ORIGIN_PATTERNS = [
  new RegExp(`^https:\\/\\/${PUBLIC_HOST.replace(/\./g, '\\.')}$`),
  new RegExp(`^https:\\/\\/[a-z0-9-]+--${PUBLIC_HOST.replace(/\./g, '\\.')}$`),
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function getCorsHeaders(req, methods = 'GET, OPTIONS') {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : PUBLIC_BASE;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

/**
 * CORS headers for public cacheable responses (seeded data, no per-user variation).
 * Uses ACAO: * so Vercel edge stores ONE cache entry per URL instead of one per
 * unique Origin. Eliminates Vary: Origin cache fragmentation that multiplies
 * origin hits by the number of distinct client origins.
 *
 * Safe to use when isDisallowedOrigin() has already blocked unauthorized origins.
 */
export function getPublicCorsHeaders(methods = 'GET, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature',
    'Access-Control-Max-Age': '3600',
  };
}

export function isDisallowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
