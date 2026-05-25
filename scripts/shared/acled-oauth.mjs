/**
 * ACLED OAuth token helper for seed scripts with refresh token support.
 *
 * Token lifecycle:
 *   1. First run: exchange email/password → access_token (24h) + refresh_token (14d)
 *   2. Store refresh_token in Redis at `acled:oauth:refresh-token`
 *   3. Subsequent runs: use refresh_token to get a new access_token (no credentials needed)
 *   4. Re-authenticate with credentials only when refresh_token expires (~14 days)
 *
 * See: https://acleddata.com/api-documentation/getting-started
 * Mirrors server/_shared/acled-auth.ts but uses Upstash REST API directly
 * so plain .mjs scripts can import it without the TS/Redis module dependency.
 */

const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_CLIENT_ID = 'acled';
const REDIS_KEY = 'acled:oauth:refresh-token';
const REDIS_TTL_SECONDS = 13 * 24 * 60 * 60; // 13 days (refresh token lasts 14, minus margin)

/**
 * Read the stored refresh token from Upstash.
 * @returns {Promise<string|null>}
 */
async function getStoredRefreshToken() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;

  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(REDIS_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.result === 'string' && data.result.length > 0 ? data.result : null;
  } catch {
    return null;
  }
}

/**
 * Store the refresh token in Upstash with a 13-day TTL.
 * @param {string} refreshToken
 */
async function storeRefreshToken(refreshToken) {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return;

  try {
    await fetch(`${url}/set/${encodeURIComponent(REDIS_KEY)}/${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: `EX ${REDIS_TTL_SECONDS}`,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * POST to the ACLED OAuth endpoint.
 * @param {URLSearchParams} body
 * @param {string} [userAgent]
 * @returns {Promise<{access_token?: string, refresh_token?: string, expires_in?: number}>}
 */
async function requestToken(body, userAgent) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (userAgent) headers['User-Agent'] = userAgent;

  const resp = await fetch(ACLED_TOKEN_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ACLED OAuth failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  return resp.json();
}

/**
 * Obtain a valid ACLED access token.
 *
 * Priority:
 *   1. Refresh token from Redis → exchange for new access_token
 *   2. ACLED_EMAIL + ACLED_PASSWORD → full OAuth exchange
 *   3. ACLED_ACCESS_TOKEN → static token (legacy, expires 24h)
 *   4. null
 *
 * @param {object} [options]
 * @param {string} [options.userAgent]
 * @returns {Promise<string|null>}
 */
export async function getAcledToken({ userAgent } = {}) {
  // 1. Try refresh token from Redis first (avoids credential exchange).
  const storedRefresh = await getStoredRefreshToken();
  if (storedRefresh) {
    try {
      console.log('  ACLED: refreshing token via stored refresh_token...');
      const data = await requestToken(
        new URLSearchParams({
          refresh_token: storedRefresh,
          grant_type: 'refresh_token',
          client_id: ACLED_CLIENT_ID,
        }),
        userAgent,
      );
      if (data.access_token) {
        // Store the new refresh token (ACLED rotates it on each refresh).
        if (data.refresh_token) await storeRefreshToken(data.refresh_token);
        console.log('  ACLED: token refreshed successfully');
        return data.access_token;
      }
    } catch (err) {
      console.warn(`  ACLED: refresh failed (${err.message}), falling back to credentials`);
    }
  }

  // 2. Full credential exchange.
  const email = (process.env.ACLED_EMAIL || '').trim();
  const password = (process.env.ACLED_PASSWORD || '').trim();

  if (email && password) {
    try {
      console.log('  ACLED: exchanging credentials for OAuth token...');
      const data = await requestToken(
        new URLSearchParams({
          username: email,
          password,
          grant_type: 'password',
          client_id: ACLED_CLIENT_ID,
          scope: 'authenticated',
        }),
        userAgent,
      );
      if (data.access_token) {
        // Store refresh token for future runs.
        if (data.refresh_token) await storeRefreshToken(data.refresh_token);
        console.log('  ACLED: OAuth token obtained successfully');
        return data.access_token;
      }
      console.warn('  ACLED: OAuth response missing access_token');
    } catch (err) {
      console.warn(`  ACLED: credential exchange failed: ${err.message}`);
    }
  }

  // 3. Static token fallback (legacy).
  const staticToken = (process.env.ACLED_ACCESS_TOKEN || '').trim();
  if (staticToken) {
    console.log('  ACLED: using static ACLED_ACCESS_TOKEN (expires after 24h)');
    return staticToken;
  }

  return null;
}
