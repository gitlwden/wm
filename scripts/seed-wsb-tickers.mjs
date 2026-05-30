#!/usr/bin/env node
/**
 * Seed WSB Ticker Scanner data from Reddit.
 * Scrapes r/wallstreetbets, r/stocks, r/investing for ticker mentions.
 * Writes to Redis key: intelligence:wsb-tickers:v1
 */
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const REDIS_KEY = 'intelligence:wsb-tickers:v1';
const CACHE_TTL = 10800; // 3h
const WSB_SUBREDDITS = ['wallstreetbets', 'stocks', 'investing'];

const DOLLAR_TICKER_REGEX = /\$([a-zA-Z]{1,5}(?:[.\-][a-zA-Z]{1,2})?)\b/g;
const BARE_TICKER_REGEX = /\b([A-Z]{1,5}(?:[.\-][A-Z]{1,2})?)\b/g;
const TICKER_BLACKLIST = new Set([
  'I','A','ALL','FOR','THE','CEO','GDP','IPO','SEC','FDA','IMF','ETF','ATH',
  'DD','YOLO','FOMO','FUD','HODL','WSB','USA','EU','UK','AI','EV','IT','OR',
  'AM','PM','ON','BE','SO','GO','AT','TO','UP','NO','IF','AS','BY','AN','DO',
  'IN','OF','IS','HAS','NEW','CFO','CTO','IRS','FBI','CIA','UN','WHO',
  'IMO','PSA','FYI','TL','DR','OP','OC','US','ER','RE','VS',
]);

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }
  return { url, token };
}

async function redisSet(url, token, key, value, ttlSeconds) {
  const resp = await fetch(
    `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttlSeconds}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
  );
  return resp.ok;
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  if (!json.result) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}

function normalizeTicker(raw) {
  return raw.toUpperCase().replace(/\./g, '-');
}

function extractTickers(text, knownTickers) {
  const found = new Set();
  if (!text) return found;
  let m;

  DOLLAR_TICKER_REGEX.lastIndex = 0;
  while ((m = DOLLAR_TICKER_REGEX.exec(text)) !== null) {
    const sym = normalizeTicker(m[1] || '');
    if (!sym || sym.length < 1) continue;
    if (TICKER_BLACKLIST.has(sym)) continue;
    found.add(sym);
  }

  if (knownTickers.size > 0) {
    BARE_TICKER_REGEX.lastIndex = 0;
    while ((m = BARE_TICKER_REGEX.exec(text)) !== null) {
      const sym = normalizeTicker(m[1] || '');
      if (!sym || sym.length < 1) continue;
      if (TICKER_BLACKLIST.has(sym)) continue;
      if (!knownTickers.has(sym)) continue;
      found.add(sym);
    }
  }
  return found;
}

async function fetchRedditHot(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=50&raw_json=1`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) { console.warn(`[WsbTickers] Reddit r/${subreddit} HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    return (data?.data?.children || []).map(c => c.data).filter(Boolean);
  } catch (e) {
    console.warn(`[WsbTickers] Reddit r/${subreddit} fetch error:`, e.message);
    return [];
  }
}

async function loadKnownTickers(url, token) {
  try {
    const raw = await redisGet(url, token, 'market:stocks-bootstrap:v1');
    const data = raw?.data ?? raw;
    if (data && Array.isArray(data.quotes)) {
      return new Set(data.quotes.map(s => s.symbol?.toUpperCase()).filter(Boolean));
    }
  } catch {}
  return new Set();
}

async function seedWsbTickers() {
  const { url, token } = getRedisCredentials();
  console.log('[WsbTickers] Fetching...');
  const t0 = Date.now();

  const knownTickers = await loadKnownTickers(url, token);
  if (knownTickers.size === 0) {
    console.warn('[WsbTickers] Known ticker set empty. $-prefixed tickers still extracted; bare uppercase disabled.');
  }

  const tickerMap = new Map();
  let postsScanned = 0;

  for (const sub of WSB_SUBREDDITS) {
    await new Promise(r => setTimeout(r, 500));
    const posts = await fetchRedditHot(sub);
    for (const p of posts) {
      postsScanned++;
      const text = `${p.title || ''} ${p.selftext || ''}`;
      const tickers = extractTickers(text, knownTickers);
      for (const sym of tickers) {
        let entry = tickerMap.get(sym);
        if (!entry) {
          entry = { symbol: sym, mentionCount: 0, postIds: new Set(), totalScore: 0, upvoteRatioSum: 0, topPost: null, subreddits: new Set() };
          tickerMap.set(sym, entry);
        }
        entry.mentionCount++;
        entry.postIds.add(p.id);
        entry.totalScore += (p.score || 0);
        entry.upvoteRatioSum += (p.upvote_ratio || 0);
        entry.subreddits.add(sub);
        if (!entry.topPost || (p.score || 0) > entry.topPost.score) {
          entry.topPost = { title: String(p.title || '').slice(0, 300), url: `https://reddit.com${p.permalink || ''}`, score: p.score || 0, subreddit: sub };
        }
      }
    }
  }

  if (tickerMap.size === 0) {
    console.warn('[WsbTickers] No tickers found.');
    return;
  }

  const tickers = [];
  for (const [, entry] of tickerMap) {
    const uniquePosts = entry.postIds.size;
    const avgUpvoteRatio = uniquePosts > 0 ? Math.round((entry.upvoteRatioSum / uniquePosts) * 100) / 100 : 0;
    const velocityScore = Math.round(Math.log1p(entry.totalScore) * entry.mentionCount * 10) / 10;
    tickers.push({ symbol: entry.symbol, mentionCount: entry.mentionCount, uniquePosts, totalScore: entry.totalScore, avgUpvoteRatio, topPost: entry.topPost, subreddits: [...entry.subreddits], velocityScore });
  }

  tickers.sort((a, b) => b.velocityScore - a.velocityScore);
  const top = tickers.slice(0, 50);
  const payload = { tickers: top, fetchedAt: Date.now(), subredditsScanned: WSB_SUBREDDITS.length, postsScanned };

  const envelope = buildEnvelope({ fetchedAt: Date.now(), recordCount: top.length, sourceVersion: 'wsb-tickers', schemaVersion: 1, state: 'OK', data: payload });
  const writeOk = await redisSet(url, token, REDIS_KEY, envelope, CACHE_TTL);

  if (writeOk) {
    const metaEnvelope = { fetchedAt: Date.now(), recordCount: top.length };
    await redisSet(url, token, 'seed-meta:intelligence:wsb-tickers', metaEnvelope, 604800);
  }

  console.log(`[WsbTickers] Seeded ${top.length} tickers from ${postsScanned} posts (redis: ${writeOk ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

seedWsbTickers().catch((err) => {
  console.error('[WsbTickers] FATAL:', err.message || err);
  process.exit(1);
});
