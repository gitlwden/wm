import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

describe('RSS timeout guard', () => {
  it('fetchFeed uses a bounded RSS proxy request', () => {
    const source = readFileSync(resolve(repoRoot, 'src/services/rss.ts'), 'utf8');

    assert.match(source, /FEED_REQUEST_TIMEOUT_MS\s*=\s*8_000/);
    assert.match(source, /fetchWithProxy\(url,\s*\{\s*signal:\s*AbortSignal\.timeout\(FEED_REQUEST_TIMEOUT_MS\)/s);
  });

  it('fetchWithProxy forwards RequestInit to direct and proxied fetches', () => {
    const source = readFileSync(resolve(repoRoot, 'src/utils/proxy.ts'), 'utf8');

    assert.match(source, /export async function fetchWithProxy\(url: string, init\?: RequestInit\)/);
    assert.match(source, /return fetch\(proxyUrl\(url\), init\)/);
    assert.match(source, /fetchAndPersist\(url, init\)/);
  });
});
