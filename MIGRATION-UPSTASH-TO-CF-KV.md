# Migration Plan: Upstash Redis → Cloudflare KV

## Problem

Upstash Redis free tier (500k requests/month) is exhausted by seed scripts running from GitHub Actions.
All seed writes fail with: `ERR max requests limit exceeded. Limit: 500000, Usage: 500000`

## Solution

Migrate to Cloudflare KV — 100k reads/day, 1k writes/day on free tier, unlimited on paid plans.

## Why Cloudflare KV over Turso

- Same key-value model as Redis — minimal code changes
- Changes concentrated in one file (`server/_shared/redis.ts`)
- Seed scripts only need API URL change
- Turso would require converting all KV ops to SQL (3-5x more work)

## Prerequisites

- [x] Cloudflare API Token (`.env.local` has R2 token)
- [ ] **New Cloudflare API Token with KV permissions** — current token is R2-scoped
- [ ] **KV Namespace created** — name: `wm-cache-prod`
- [ ] GitHub Actions secret `CLOUDFLARE_KV_NAMESPACE_ID` added

### Create KV namespace (after getting KV-enabled token)

```bash
# Create namespace
curl -X POST "https://api.cloudflare.com/client/v4/accounts/768b3115e9ab856c072dddc7f14127c4/storage/kv/namespaces" \
  -H "Authorization: Bearer <KV_ENABLED_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"wm-cache-prod"}'

# Response will contain the namespace ID (e.g., "abc123...")
```

## API Mapping

| Operation | Upstash | Cloudflare KV |
|-----------|---------|---------------|
| GET | `GET /get/{key}` | `GET /values/{key}` |
| SET (with TTL) | `SET /set/{key}/{val}/EX/{ttl}` | `PUT /values/{key}?expiration_ttl={ttl}` |
| DEL | `POST /del/{key}` | `DELETE /values/{key}` |
| Pipeline (batch) | `POST /pipeline` | Individual GET calls (in-process cache compensates) |

### Cloudflare KV REST API format

```
Base URL: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}

Headers: Authorization: Bearer {API_TOKEN}

GET    /values/{key}                  → returns value as string
PUT    /values/{key}?expiration_ttl=N → sets value with TTL (seconds)
DELETE /values/{key}                  → deletes key
```

## Files to Change

### 1. `server/_shared/redis.ts` (core)

Replace all Upstash REST calls with Cloudflare KV REST calls:
- `getCachedJson` — GET `/values/{key}`
- `getRawJson` — GET `/values/{key}`
- `getCachedRawString` — GET `/values/{key}`
- `setCachedJson` — PUT `/values/{key}?expiration_ttl={ttl}`
- `getCachedJsonBatch` — N individual GET calls (or use KV list/bulk)
- `runRedisPipeline` — adapt or deprecate
- `deleteRedisKey` — DELETE `/values/{key}`
- `geoSearchByBox` — not supported, keep stub returning []
- `getHashFieldsBatch` — not supported, keep stub returning empty Map

New env vars:
- `CLOUDFLARE_ACCOUNT_ID` (reuse from R2 config)
- `CLOUDFLARE_KV_NAMESPACE_ID` (new)
- `CLOUDFLARE_API_TOKEN` (reuse, but needs KV permissions)

### 2. `scripts/seed-*.mjs` (~25 files)

Replace Upstash write pattern with Cloudflare KV write.

Before:
```js
await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ttl}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
});
```

After:
```js
await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}?expiration_ttl=${ttl}`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
  body: value,
});
```

Extract shared helper to `scripts/_seed-utils.mjs` (already exists).

### 3. `.env.local`

Add:
```
CLOUDFLARE_KV_NAMESPACE_ID=<namespace_id>
```

### 4. GitHub Actions secrets

Add:
- `CLOUDFLARE_KV_NAMESPACE_ID`

Update all workflows that reference `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to use Cloudflare KV env vars.

### 5. `server/_shared/redis.ts` env variable names

Update env var reads from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to Cloudflare equivalents.

## Migration Strategy

1. **Dual-write phase** (optional): Write to both Upstash and CF KV, read from CF KV
2. **Cutover**: Switch all reads/writes to CF KV
3. **Cleanup**: Remove Upstash env vars and references

## Rollback

Keep Upstash env vars in place during migration. If CF KV fails, revert code changes.
