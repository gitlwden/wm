#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:shipping_stress:v1';
const TTL = 3600; // 1h — seed runs every 15min (4× safety margin)

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const SHIPPING_CARRIERS = [
  { symbol: 'BDRY', name: 'Breakwave Dry Bulk ETF',  carrierType: 'etf' },
  { symbol: 'ZIM',  name: 'ZIM Integrated Shipping', carrierType: 'carrier' },
  { symbol: 'MATX', name: 'Matson Inc',              carrierType: 'carrier' },
  { symbol: 'SBLK', name: 'Star Bulk Carriers',      carrierType: 'carrier' },
  { symbol: 'EGLE', name: 'Eagle Bulk Shipping',       carrierType: 'carrier' },
];

function parseYahooChartJson(body) {
  try {
    const data = JSON.parse(body);
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = Array.isArray(closes) ? closes.filter((v) => v != null) : [];
    return { price, change, sparkline };
  } catch { return null; }
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`  [ShippingStress] Yahoo ${symbol} HTTP ${resp.status}`);
      return null;
    }
    const body = await resp.text();
    return parseYahooChartJson(body);
  } catch (e) {
    console.warn(`  [ShippingStress] Yahoo ${symbol} error: ${e.message}`);
    return null;
  }
}

export async function fetchAll() {
  const results = [];
  for (const carrier of SHIPPING_CARRIERS) {
    await new Promise(r => setTimeout(r, 150));
    const quote = await fetchYahooChart(carrier.symbol);
    if (!quote) continue;
    results.push({
      symbol: carrier.symbol,
      name: carrier.name,
      carrierType: carrier.carrierType,
      price: quote.price,
      changePct: Number(quote.change.toFixed(2)),
      sparkline: quote.sparkline,
    });
  }
  if (!results.length) {
    throw new Error('No carrier data available from Yahoo Finance');
  }
  const avgChange = results.reduce((a, b) => a + b.changePct, 0) / results.length;
  // Neutral market (0% change) -> score=40 (moderate). Positive change = lower stress.
  const stressScore = Math.min(100, Math.max(0, Math.round(40 - avgChange * 3)));
  const stressLevel = stressScore >= 75 ? 'critical' : stressScore >= 50 ? 'elevated' : stressScore >= 25 ? 'moderate' : 'low';
  return { carriers: results, stressScore, stressLevel };
}

export function validateFn(data) {
  return data && typeof data === 'object' && Array.isArray(data.carriers) && data.carriers.length > 0;
}

export function declareRecords(data) {
  return data?.carriers?.length ?? 0;
}

const isMain = process.argv[1]?.endsWith('seed-shipping-stress.mjs');
if (isMain) {
  runSeed('supply_chain', 'shipping_stress', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'shipping-stress',
    schemaVersion: 1,
    declareRecords,
    recordCount: (data) => data?.carriers?.length ?? 0,
    maxStaleMin: 120,
    afterPublish: async (data, { recordCount }) => {
      if (data.stressScore >= 75) {
        console.log(`  [ShippingStress] ALERT: score=${data.stressScore}/${data.stressLevel} (${recordCount} carriers)`);
      }
    },
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
