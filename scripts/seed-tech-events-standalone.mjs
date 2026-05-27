#!/usr/bin/env node

import { loadEnvFile, runSeed, sleep } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'research:tech-events:v1';
const BOOTSTRAP_KEY = 'research:tech-events-bootstrap:v1';
const CACHE_TTL = 86400; // 24h
const META_TTL = 604800; // 7d
const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
const RSS_URL = 'https://dev.events/rss.xml';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TECH_EVENTS_CURATED = [
  { id: 'gitex-global-2026', title: 'GITEX Global 2026', type: 'conference', location: 'Dubai World Trade Centre, Dubai', startDate: '2026-12-07', endDate: '2026-12-11', url: 'https://www.gitex.com', source: 'curated', description: "World's largest tech & startup show" },
  { id: 'token2049-dubai-2026', title: 'TOKEN2049 Dubai 2026', type: 'conference', location: 'Dubai, UAE', startDate: '2026-04-29', endDate: '2026-04-30', url: 'https://www.token2049.com', source: 'curated', description: 'Premier crypto event in Dubai' },
  { id: 'collision-2026', title: 'Collision 2026', type: 'conference', location: 'Toronto, Canada', startDate: '2026-06-22', endDate: '2026-06-25', url: 'https://collisionconf.com', source: 'curated', description: "North America's fastest growing tech conference" },
  { id: 'web-summit-2026', title: 'Web Summit 2026', type: 'conference', location: 'Lisbon, Portugal', startDate: '2026-11-02', endDate: '2026-11-05', url: 'https://websummit.com', source: 'curated', description: "The world's premier tech conference" },
];

// ─── Redis helpers (Upstash REST) ───

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }
  return { url, token };
}

async function redisSet(key, value, ttlSeconds) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data?.result === 'OK';
}

async function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const envelope = buildEnvelope({
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'tech-events',
    schemaVersion: meta?.schemaVersion ?? 1,
    state: 'OK',
    data,
  });
  return redisSet(key, envelope, ttlSeconds);
}

// ─── Fetch helpers ───

function fetchUrl(url) {
  return new Promise((resolve) => {
    const request = fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/calendar, application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    request.then(async (resp) => {
      if (!resp.ok) return resolve(null);
      resolve(await resp.text());
    }).catch(() => resolve(null));
    // Race against timeout
    AbortSignal.timeout(15_000).addEventListener('abort', () => resolve(null), { once: true });
  });
}

// ─── ICS parser (Techmeme) ───

function parseICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const locationMatch = block.match(/LOCATION:(.+)/);
    const dtstartMatch = block.match(/DTSTART;VALUE=DATE:(\d+)/);
    const dtendMatch = block.match(/DTEND;VALUE=DATE:(\d+)/);
    const urlMatch = block.match(/URL:(.+)/);
    const uidMatch = block.match(/UID:(.+)/);
    if (!summaryMatch || !dtstartMatch) continue;
    const summary = summaryMatch[1].trim();
    const location = locationMatch ? locationMatch[1].trim() : '';
    const startDate = dtstartMatch[1];
    const endDate = dtendMatch ? dtendMatch[1] : startDate;
    let type = 'other';
    if (summary.startsWith('Earnings:')) type = 'earnings';
    else if (summary.startsWith('IPO')) type = 'ipo';
    else if (location) type = 'conference';
    events.push({
      id: uidMatch ? uidMatch[1].trim() : '',
      title: summary,
      type,
      location,
      startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`,
      endDate: `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`,
      url: urlMatch ? urlMatch[1].trim() : '',
      source: 'techmeme',
      description: '',
    });
  }
  return events;
}

// ─── RSS parser (dev.events) ───

function parseRSS(rssText) {
  const events = [];
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guidMatch = item.match(/<guid[^>]*>(.*?)<\/guid>/);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2]) : null;
    if (!title) continue;
    const link = linkMatch ? linkMatch[1] || '' : '';
    const description = descMatch ? (descMatch[1] ?? descMatch[2] ?? '') : '';
    const guid = guidMatch ? guidMatch[1] || '' : '';
    const dateMatch = description.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!Number.isNaN(parsed.getTime())) startDate = parsed.toISOString().split('T')[0];
    }
    if (!startDate) continue;
    if (new Date(startDate) < new Date(new Date().toISOString().split('T')[0])) continue;
    let location = null;
    const locMatch = description.match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i) ||
                     description.match(/Location:\s*([^<\n]+)/i);
    if (locMatch) location = locMatch[1].trim();
    if (description.toLowerCase().includes('online')) location = 'Online';
    events.push({
      id: guid || `dev-events-${title.slice(0, 20)}`,
      title,
      type: 'conference',
      location: location || '',
      startDate,
      endDate: startDate,
      url: link,
      source: 'dev.events',
      description: '',
    });
  }
  return events;
}

// ─── Main fetch + seed logic ───

async function fetchAllTechEvents() {
  const [icsText, rssText] = await Promise.all([
    fetchUrl(ICS_URL),
    fetchUrl(RSS_URL),
  ]);

  let events = [];

  if (icsText) {
    const parsed = parseICS(icsText);
    events.push(...parsed);
    console.log(`  Techmeme ICS: ${parsed.length} events`);
  } else {
    console.warn('  Techmeme ICS fetch failed');
  }

  if (rssText) {
    const parsed = parseRSS(rssText);
    events.push(...parsed);
    console.log(`  dev.events RSS: ${parsed.length} events`);
  } else {
    console.warn('  dev.events RSS fetch failed');
  }

  // Add curated events that are still in the future
  const today = new Date().toISOString().split('T')[0];
  for (const curated of TECH_EVENTS_CURATED) {
    if (curated.startDate >= today) events.push(curated);
  }

  // Deduplicate by normalized title + year
  const seen = new Set();
  events = events.filter((e) => {
    const year = e.startDate.slice(0, 4);
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + year;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date
  events.sort((a, b) => a.startDate.localeCompare(b.startDate));

  return {
    success: true,
    count: events.length,
    conferenceCount: events.filter((e) => e.type === 'conference').length,
    mappableCount: 0,
    lastUpdated: new Date().toISOString(),
    events,
    error: '',
  };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

async function afterPublish(data) {
  // Also write the bootstrap key (same payload, same TTL)
  const ok = await envelopeWrite(BOOTSTRAP_KEY, data, CACHE_TTL, {
    recordCount: data.events.length,
    sourceVersion: 'tech-events',
  });
  console.log(`  Bootstrap key ${BOOTSTRAP_KEY}: ${ok ? 'OK' : 'FAIL'}`);
}

if (process.argv[1]?.endsWith('seed-tech-events-standalone.mjs')) {
  runSeed('research', 'tech-events', CANONICAL_KEY, fetchAllTechEvents, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'tech-events',
    schemaVersion: 1,
    declareRecords,
    afterPublish,
    maxStaleMin: 720, // 12h — 2x the 6h cron interval
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
