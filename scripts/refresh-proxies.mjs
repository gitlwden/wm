#!/usr/bin/env node
/**
 * Fetches free proxy lists from multiple GitHub repos, tests HTTPS
 * connectivity, and outputs working proxies.
 *
 * Caches results to .proxy-cache.json (12h TTL). Subsequent runs
 * within the TTL window skip the fetch/test and return cached proxies.
 *
 * Usage:
 *   node scripts/refresh-proxies.mjs              # stdout JSON
 *   node scripts/refresh-proxies.mjs --force      # ignore cache
 *   node scripts/refresh-proxies.mjs --set-env     # write to $GITHUB_ENV
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '..', '.proxy-cache.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - cache.ts < CACHE_TTL_MS && cache.proxy_url) return cache;
    return null;
  } catch { return null; }
}

function writeCache(data) {
  writeFileSync(CACHE_PATH, JSON.stringify({ ...data, ts: Date.now() }));
}

function outputResults(proxyUrl, pool) {
  console.log(`\nPrimary: ${proxyUrl}`);
  console.log(`Pool: ${JSON.stringify(pool)}`);
  const setEnv = process.argv.includes('--set-env');
  if (setEnv && process.env.GITHUB_ENV) {
    writeFileSync(process.env.GITHUB_ENV, `PROXY_URL=${proxyUrl}\n`, { flag: 'a' });
    writeFileSync(process.env.GITHUB_ENV, `PROXY_POOL=${JSON.stringify(pool)}\n`, { flag: 'a' });
    console.log('\nWritten to $GITHUB_ENV');
  }
  console.log(`\n__JSON__${JSON.stringify({ proxy_url: proxyUrl, pool, count: pool.length })}__JSON__`);
}


const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/http_proxies.txt',
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/http_proxies.txt',
];

const TEST_URL_HTTPS = 'https://httpbin.org/ip';
const CONCURRENCY = 50;
const TIMEOUT_MS = 5_000;
const TARGET_WORKING = 10;
const FETCH_TIMEOUT = 15_000;

async function fetchProxyList(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'worldmonitor/2.8.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    return text.split('\n')
      .map(l => l.trim())
      .filter(l => l && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
  } catch {
    return [];
  }
}

import { createRequire } from 'node:module';
const { proxyFetch, parseProxyConfig } = createRequire(import.meta.url)('./_proxy-utils.cjs');

async function testProxy(proxy) {
  const proxyUrl = `http://${proxy}`;
  const config = parseProxyConfig(proxyUrl);
  if (!config) return null;

  try {
    const result = await proxyFetch(TEST_URL_HTTPS, config, {
      accept: 'application/json',
      timeoutMs: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (result.ok) {
      JSON.parse(result.buffer.toString('utf8'));
      return proxyUrl;
    }
  } catch { /* skip */ }
  return null;
}

async function testBatch(proxies) {
  const results = [];
  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(testProxy));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
        if (results.length >= TARGET_WORKING) return results;
      }
    }
  }
  return results;
}

async function main() {
  // Check cache first (unless --force)
  if (!process.argv.includes('--force')) {
    const cached = readCache();
    if (cached) {
      console.log(`Cache hit (${cached.count} proxies, ${Math.round((Date.now() - cached.ts) / 60000)}min ago). Testing...`);
      const quickTest = await testBatch(cached.pool.slice(0, 3));
      if (quickTest.length > 0) {
        console.log(`  ${quickTest.length}/${Math.min(3, cached.pool.length)} cached proxies still working — using cache`);
        outputResults(cached.proxy_url, cached.pool);
        return;
      }
      console.log('  Cached proxies all dead — refreshing...');
    }
  }

  console.log(`Fetching proxies from ${PROXY_SOURCES.length} sources...`);

  const allLists = await Promise.allSettled(PROXY_SOURCES.map(fetchProxyList));
  const rawProxies = [];
  for (let i = 0; i < allLists.length; i++) {
    const r = allLists[i];
    const count = r.status === 'fulfilled' ? r.value.length : 0;
    console.log(`  Source ${i + 1}: ${count} proxies`);
    if (r.status === 'fulfilled') rawProxies.push(...r.value);
  }

  // Deduplicate
  const unique = [...new Set(rawProxies)];
  console.log(`Total unique proxies: ${unique.length}`);

  // Shuffle to avoid always testing the same ones first
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }

  console.log(`Testing up to ${Math.min(unique.length, 500)} proxies (${CONCURRENCY} concurrent, ${TIMEOUT_MS}ms timeout)...`);
  const working = await testBatch(unique.slice(0, 500));

  if (working.length === 0) {
    console.error('ERROR: No working proxies found');
    process.exit(1);
  }

  console.log(`Found ${working.length} working proxies`);

  // Cache results
  writeCache({ proxy_url: working[0], pool: working, count: working.length });

  outputResults(working[0], working);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
