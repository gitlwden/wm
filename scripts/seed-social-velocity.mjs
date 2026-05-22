#!/usr/bin/env node

/**
 * Seed Social Velocity data from Reddit (r/worldnews, r/geopolitics)
 * 
 * This script fetches hot posts from Reddit and stores them in Upstash Redis.
 * It is designed to run as a GitHub Actions workflow on a schedule.
 */

import { loadEnvFile, CHROME_UA } from './_seed-utils.mjs';
import { buildEnvelope, unwrapEnvelope } from './_seed-envelope-source.mjs';
import { resolveRecordCount } from './_seed-contract.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:social:reddit:v1';
const SEED_META_KEY = 'seed-meta:intelligence:social-reddit';
const CACHE_TTL = 10800; // 3 hours
const REDDIT_SUBREDDITS = ['worldnews', 'geopolitics'];
const REDDIT_USER_AGENT = 'WorldMonitor/1.0 (contact: info@worldmonitor.app)';

/**
 * Fetch hot posts from a subreddit
 */
async function fetchRedditHot(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=25&raw_json=1`;
  const resp = await fetch(url, {
    headers: { 
      Accept: 'application/json', 
      'User-Agent': REDDIT_USER_AGENT 
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    console.warn(`[SocialVelocity] Reddit r/${subreddit} HTTP ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return (data?.data?.children || []).map(c => c.data).filter(Boolean);
}

/**
 * Validate the data structure
 */
function validate(data) {
  return Array.isArray(data?.posts) && data.posts.length >= 1;
}

/**
 * Main seed function
 */
async function seedSocialVelocity() {
  console.log('[SocialVelocity] Starting seed...');
  const t0 = Date.now();
  
  try {
    const nowSec = Date.now() / 1000;
    const allPosts = [];
    const seenUrls = new Set();
    
    for (const sub of REDDIT_SUBREDDITS) {
      // Stagger requests to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
      const posts = await fetchRedditHot(sub);
      
      for (const p of posts) {
        // Deduplicate cross-subreddit reposts of the same article URL
        const articleUrl = p.url || '';
        const isExternal = articleUrl && !articleUrl.includes('reddit.com');
        if (isExternal && seenUrls.has(articleUrl)) continue;
        if (isExternal) seenUrls.add(articleUrl);
        
        const ageSec = Math.max(1, nowSec - (p.created_utc || nowSec));
        const recencyFactor = Math.exp(-ageSec / (6 * 3600));
        const velocityScore = Math.log1p(p.score || 1) * (p.upvote_ratio || 0.5) * recencyFactor * 100;
        
        allPosts.push({
          id: String(p.id || ''),
          title: String(p.title || '').slice(0, 300),
          subreddit: sub,
          url: `https://reddit.com${p.permalink || ''}`,
          score: p.score || 0,
          upvoteRatio: p.upvote_ratio || 0,
          numComments: p.num_comments || 0,
          velocityScore: Math.round(velocityScore * 10) / 10,
          createdAt: Math.round((p.created_utc || nowSec) * 1000),
        });
      }
    }
    
    if (!allPosts.length) {
      console.warn('[SocialVelocity] No posts fetched');
      process.exit(1);
    }
    
    // Sort by velocity score and take top 30
    allPosts.sort((a, b) => b.velocityScore - a.velocityScore);
    const top = allPosts.slice(0, 30);
    const payload = { posts: top, fetchedAt: Date.now() };
    
    // Write to Redis using envelope format
    const { url, token } = getRedisCredentials();
    const envelope = buildEnvelope(payload, { recordCount: top.length, sourceVersion: 'social-reddit' });
    
    const setResp = await fetch(`${url}/set/${encodeURIComponent(CANONICAL_KEY)}/${encodeURIComponent(JSON.stringify(envelope))}/EX/${CACHE_TTL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    
    if (!setResp.ok) {
      throw new Error(`Redis SET failed: HTTP ${setResp.status}`);
    }
    
    // Write seed metadata
    const metaPayload = { fetchedAt: Date.now(), recordCount: top.length };
    const metaResp = await fetch(`${url}/set/${encodeURIComponent(SEED_META_KEY)}/${encodeURIComponent(JSON.stringify(metaPayload))}/EX/604800`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    
    console.log(`[SocialVelocity] Seeded ${top.length} posts in ${((Date.now() - t0) / 1000).toFixed(1)}s (redis: ${setResp.ok ? 'OK' : 'FAIL'})`);
    
    if (!validate(payload)) {
      throw new Error('Validation failed');
    }
    
  } catch (err) {
    console.error('[SocialVelocity] Seed error:', err?.message || err);
    process.exit(1);
  }
}

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }
  return { url, token };
}

// Run the seed
seedSocialVelocity().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});