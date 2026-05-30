#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:sectors:v2';
const TTL = 900; // 15 min

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
const SECTOR_NAMES = {
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Health Care',
  XLY: 'Consumer Disc.', XLI: 'Industrials', XLP: 'Consumer Staples',
  XLU: 'Utilities', XLB: 'Materials', XLRE: 'Real Estate', XLC: 'Comm Services', SMH: 'Semiconductors',
};

export function declareRecords(data) {
  return Array.isArray(data?.sectors) ? data.sectors.length : 0;
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  if (!price || !prevClose) return null;
  return { change: ((price - prevClose) / prevClose) * 100 };
}

async function fetchSectors() {
  const sectors = [];
  for (const symbol of SECTOR_SYMBOLS) {
    try {
      const data = await fetchYahooChart(symbol);
      if (data) {
        sectors.push({
          symbol,
          name: SECTOR_NAMES[symbol] || symbol,
          change: Math.round(data.change * 100) / 100,
        });
      }
    } catch { /* skip failed */ }
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  if (sectors.length === 0) throw new Error('No sector data fetched');

  return { sectors, updatedAt: new Date().toISOString() };
}

await runSeed('market', 'sectors', CANONICAL_KEY, fetchSectors, {
  ttlSeconds: TTL,
  sourceVersion: 'yahoo-v1',
  declareRecords,
  schemaVersion: 2,
  maxStaleMin: 60,
}).catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
