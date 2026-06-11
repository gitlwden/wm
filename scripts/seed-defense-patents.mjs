#!/usr/bin/env node
// Seed defense/dual-use patent filings from Google Patents.
// Weekly cron — top 20 recent filings per strategic CPC category.

import { loadEnvFile, runSeed, sleep, httpsProxyFetchRaw } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'patents:defense:latest';
const CACHE_TTL = 1_814_400; // 21 days (3× weekly interval)
const GOOGLE_PATENTS_XHR = 'https://patents.google.com/xhr/query';
const INTER_CATEGORY_DELAY_MS = 5_000;
const MAX_PER_CATEGORY = 20;

// Proxy support for CI environments where Google rate-limits direct requests
let _proxyPool = null;
function getProxyPool() {
  if (_proxyPool) return _proxyPool;
  try { _proxyPool = JSON.parse(process.env.PROXY_POOL || '[]'); } catch { _proxyPool = []; }
  if (_proxyPool.length === 0 && process.env.PROXY_URL) _proxyPool = [process.env.PROXY_URL];
  return _proxyPool;
}

async function fetchWithProxy(urlStr, headers, timeoutMs) {
  try {
    const resp = await fetch(urlStr, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.ok) return resp;
  } catch { /* fall through to proxy */ }
  const pool = getProxyPool().slice(0, 3);
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
    } catch { }
  }
  throw new Error('All fetch methods failed');
}

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

function isDefenseAssignee(assignee) {
  if (!assignee) return false;
  const lower = assignee.toLowerCase();
  return DEFENSE_ASSIGNEES.some((a) => lower.includes(a.toLowerCase()));
}

async function fetchCategoryPatents(category) {
  // Query one assignee at a time to avoid Google rate-limiting long queries
  const allPatents = [];
  for (const assignee of DEFENSE_ASSIGNEES) {
    const q = `CPC=${category.code} AND assignee=${assignee}`;
    const url = `${GOOGLE_PATENTS_XHR}?url=${encodeURIComponent(q)}&exp=&tags=`;

    try {
      const resp = await fetchWithProxy(url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      }, 15_000);

      if (!resp.ok) continue;
      const data = await resp.json();
      const results = data.results?.cluster?.[0]?.result ?? [];

      for (const r of results) {
        const p = r.patent ?? {};
        const patentId = (p.publication_number ?? '').replace(/[^A-Z0-9]/gi, '');
        if (!patentId) continue;
        allPatents.push({
          patentId,
          title: String(p.title ?? '').trim().slice(0, 300),
          date: String(p.grant_date || p.publication_date || p.filing_date || ''),
          assignee: String(p.assignee ?? '').slice(0, 200),
          cpcCode: category.code,
          cpcDesc: category.desc,
          abstract: String(p.snippet ?? '').replace(/&hellip;/g, '…').slice(0, 500),
          url: patentId ? `https://patents.google.com/patent/${p.publication_number}/en` : '',
        });
      }
    } catch { /* skip failed assignee */ }
    await sleep(1_000); // Be gentle with Google
  }

  // Deduplicate within this category only (same patent can appear in multiple categories)
  const seen = new Set();
  return allPatents
    .filter((p) => {
      if (!p.patentId || !p.date || seen.has(p.patentId)) return false;
      seen.add(p.patentId);
      return true;
    })
    .slice(0, MAX_PER_CATEGORY);
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

  // Sort newest first — no cross-category dedup so each tab has its own data
  all.sort((a, b) => b.date.localeCompare(a.date));

  return { patents: all, total: all.length, fetchedAt: new Date().toISOString() };
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
  sourceVersion: 'google-patents-v1',
  recordCount: (d) => d?.patents?.length ?? 0,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 25200,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
