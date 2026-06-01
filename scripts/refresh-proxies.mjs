#!/usr/bin/env node
/**
 * Fetches free proxy lists from multiple GitHub repos, tests HTTPS
 * connectivity, and outputs working proxies.
 *
 * Used by refresh-proxies.yml workflow to populate PROXY_URL / PROXY_POOL
 * repo variables for seeder workflows.
 *
 * Usage:
 *   node scripts/refresh-proxies.mjs              # stdout JSON
 *   node scripts/refresh-proxies.mjs --set-env     # write to $GITHUB_ENV
 */

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

  const primary = working[0];
  const pool = JSON.stringify(working);

  console.log(`\nPrimary: ${primary}`);
  console.log(`Pool: ${pool}`);

  // Output for GitHub Actions
  const setEnv = process.argv.includes('--set-env');
  if (setEnv && process.env.GITHUB_ENV) {
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.GITHUB_ENV, `PROXY_URL=${primary}\n`);
    fs.appendFileSync(process.env.GITHUB_ENV, `PROXY_POOL=${pool}\n`);
    console.log('\nWritten to $GITHUB_ENV');
  }

  // Also output as JSON for programmatic consumption
  console.log(`\n__JSON__${JSON.stringify({ proxy_url: primary, pool: working, count: working.length })}__JSON__`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
