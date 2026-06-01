#!/usr/bin/env node
// Seed USPTO PatentsView defense/dual-use patent filings (issue #2047).
// Weekly cron — top 20 recent filings per strategic CPC category.

import { loadEnvFile, CHROME_UA, runSeed, sleep, httpsProxyFetchRaw } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'patents:defense:latest';

// Proxy pool — try multiple free proxies since they're unreliable
let _proxyPool = null;
function getProxyPool() {
  if (_proxyPool) return _proxyPool;
  try { _proxyPool = JSON.parse(process.env.PROXY_POOL || '[]'); } catch { _proxyPool = []; }
  if (_proxyPool.length === 0 && process.env.PROXY_URL) _proxyPool = [process.env.PROXY_URL];
  return _proxyPool;
}

async function fetchWithProxy(urlStr, headers, timeoutMs) {
  // Try direct first
  try {
    const resp = await fetch(urlStr, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.ok) return resp;
  } catch { /* fall through to proxy */ }

  // Try each proxy in the pool
  const pool = getProxyPool();
  for (const proxy of pool) {
    try {
      const proxied = await httpsProxyFetchRaw(urlStr, proxy, {
        accept: headers.Accept || 'application/json',
        timeoutMs,
      });
      return {
        ok: true,
        json: () => Promise.resolve(JSON.parse(proxied.buffer.toString('utf8'))),
      };
    } catch { continue; }
  }
  throw new Error('All proxies failed');
}
const CACHE_TTL = 1_814_400; // 21 days (3× weekly interval)
const PATENTSVIEW_API = 'https://search.patentsview.org/api/v1/patent/';
const INTER_CATEGORY_DELAY_MS = 3_000;
const MAX_PER_CATEGORY = 20;

// Key defense/dual-use assignees
const DEFENSE_ASSIGNEES = [
  'Raytheon', 'Lockheed', 'Northrop', 'Huawei', 'SMIC', 'TSMC', 'DARPA',
  'Boeing', 'L3Harris', 'General Dynamics', 'BAE Systems', 'Thales',
];

// Strategic CPC classes
const CPC_CATEGORIES = [
  { code: 'H04B', desc: 'Transmission / Communications' },
  { code: 'H01L', desc: 'Semiconductor devices' },
  { code: 'F42B', desc: 'Ammunition / Explosives' },
  { code: 'G06N', desc: 'AI / Neural networks' },
  { code: 'C12N', desc: 'Microorganisms / Biotechnology' },
];

function buildQuery(cpcCode) {
  return JSON.stringify({
    _and: [
      { _begins: { 'cpc_at_issue.cpc_subclass_id': cpcCode } },
      {
        _or: DEFENSE_ASSIGNEES.map((a) => ({ _text_phrase: { 'assignees.assignee_organization': a } })),
      },
    ],
  });
}

async function fetchCategoryPatents(category) {
  const url = new URL(PATENTSVIEW_API);
  url.searchParams.set('q', buildQuery(category.code));
  url.searchParams.set('f', JSON.stringify(['patent_id', 'patent_title', 'patent_date', 'patent_abstract', 'assignees.assignee_organization', 'cpc_at_issue.cpc_subclass_id']));
  url.searchParams.set('o', JSON.stringify({ size: MAX_PER_CATEGORY }));
  url.searchParams.set('s', JSON.stringify([{ patent_date: 'desc' }]));

  const resp = await fetchWithProxy(url.toString(), { 'User-Agent': CHROME_UA, Accept: 'application/json' }, 20_000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.patents ?? []).map((p) => ({
    patentId: String(p.patent_id ?? ''),
    title: String(p.patent_title ?? '').slice(0, 300),
    date: String(p.patent_date ?? ''),
    assignee: String(p.assignees?.[0]?.assignee_organization ?? '').slice(0, 200),
    cpcCode: category.code,
    cpcDesc: category.desc,
    abstract: String(p.patent_abstract ?? '').slice(0, 500),
    url: p.patent_id ? `https://patents.google.com/patent/US${p.patent_id}` : '',
  })).filter((p) => p.patentId && p.date);
}

async function fetchAllPatents() {
  const all = [];

  for (let i = 0; i < CPC_CATEGORIES.length; i++) {
    const category = CPC_CATEGORIES[i];
    if (i > 0) await sleep(INTER_CATEGORY_DELAY_MS);
    console.log(`  Fetching ${category.code} (${category.desc})...`);

    try {
      const patents = await fetchCategoryPatents(category);
      console.log(`    ${patents.length} patents`);
      all.push(...patents);
    } catch (err) {
      console.warn(`    ${category.code}: failed (${err.message})`);
    }
  }

  // Deduplicate by patentId and sort newest first
  const seen = new Set();
  const deduped = all.filter((p) => {
    if (seen.has(p.patentId)) return false;
    seen.add(p.patentId);
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));

  return { patents: deduped, total: deduped.length, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  return Array.isArray(data?.patents) && data.patents.length > 0;
}

export function declareRecords(data) {
  return data?.patents?.length ?? 0;
}

runSeed('military', 'defense-patents', CANONICAL_KEY, fetchAllPatents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'patentsview-v1',
  recordCount: (d) => d?.patents?.length ?? 0,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 25200,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
