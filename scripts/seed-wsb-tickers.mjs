#!/usr/bin/env node
/**
 * Seed WSB Ticker Scanner data from Yahoo Finance trending tickers.
 * Replaces Reddit scraping (blocked from datacenter IPs).
 * Writes to Redis key: intelligence:wsb-tickers:v1
 */
import { loadEnvFile, CHROME_UA, runSeed, kvSet } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const REDIS_KEY = 'intelligence:wsb-tickers:v1';
const CACHE_TTL = 10800; // 3h
const TRENDING_URL = 'https://query1.finance.yahoo.com/v1/finance/trending/US?count=50';

async function fetchTrendingTickers() {
  const resp = await fetch(TRENDING_URL, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Yahoo trending HTTP ${resp.status}`);
  const data = await resp.json();
  const quotes = data?.finance?.result?.[0]?.quotes ?? [];
  return quotes;
}

async function enrichTickers(quotes) {
  const tickers = [];
  for (const q of quotes) {
    const symbol = q.symbol;
    if (!symbol) continue;
    // Skip indices and pure crypto
    if (symbol.startsWith('^')) continue;
    if (symbol.includes('-USD') || symbol.includes('-EUR')) continue;

    tickers.push({
      symbol,
      mentionCount: 1,
      uniquePosts: 1,
      totalScore: 0,
      avgUpvoteRatio: 0,
      topPost: { title: q.shortName || q.longName || symbol, url: `https://finance.yahoo.com/quote/${symbol}/`, score: 0, subreddit: 'yahoo-trending' },
      subreddits: ['yahoo-trending'],
      velocityScore: 0,
    });
  }
  // Assign velocity scores based on position (higher position = more trending)
  tickers.forEach((t, i) => {
    t.velocityScore = Math.round((tickers.length - i) * 10) / 10;
  });
  return tickers;
}

async function seedWsbTickers() {
  console.log('[WsbTickers] Fetching Yahoo trending...');
  const t0 = Date.now();

  const quotes = await fetchTrendingTickers();
  if (quotes.length === 0) throw new Error('No trending tickers from Yahoo');

  const tickers = await enrichTickers(quotes);
  const top = tickers.slice(0, 50);

  const payload = { tickers: top, fetchedAt: Date.now(), subredditsScanned: 1, postsScanned: quotes.length };
  const envelope = buildEnvelope({ fetchedAt: Date.now(), recordCount: top.length, sourceVersion: 'yahoo-trending-v1', schemaVersion: 1, state: 'OK', data: payload });
  let writeOk = false;
  try {
    await kvSet(REDIS_KEY, envelope, CACHE_TTL);
    writeOk = true;
  } catch { /* fail */ }

  if (writeOk) {
    await kvSet('seed-meta:intelligence:wsb-tickers', { fetchedAt: Date.now(), recordCount: top.length }, 604800);
  }

  console.log(`[WsbTickers] Seeded ${top.length} tickers from ${quotes.length} trending (redis: ${writeOk ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

seedWsbTickers().catch((err) => {
  console.error('[WsbTickers] FATAL:', err.message || err);
  process.exit(1);
});
