#!/usr/bin/env node
/**
 * Scrape Iran-related military/conflict events from Google News RSS.
 * Writes scripts/data/iran-events-latest.json for seed-iran-events.mjs.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');
const OUTPUT = path.join(DATA_DIR, 'iran-events-latest.json');

const QUERIES = [
  'Iran+attack+military',
  'Iran+missile+strike',
  'Iran+IRGC+operation',
  'Iran+air+defense',
  'Iran+nuclear+site',
  'Iran+proxy+attack',
  'Iran+drone+strike',
  'Houthi+Iran+attack',
];

async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseRss(xml);
  } catch (e) {
    console.error(`  [scrape] ${query}: ${e.message}`);
    return [];
  }
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    if (!title || !link) continue;
    items.push({ title: decodeHtml(title), link, pubDate });
  }
  return items;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…');
}

function relativeTime(pubDate) {
  if (!pubDate) return '';
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const hours = Math.floor(diffMs / 3600_000);
  if (hours < 1) return `${Math.floor(diffMs / 60_000)} minutes ago`;
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function categorize(title) {
  const lower = title.toLowerCase();
  if (/missile|strike|airstrike|bomb|attack|drone/.test(lower)) return 'cat10';
  if (/military|irgc|guard|force|troop/.test(lower)) return 'cat1';
  if (/nuclear|centrifuge|enrichment|iaea/.test(lower)) return 'cat11';
  if (/protest|demonstration|unrest|rally/.test(lower)) return 'cat7';
  if (/sanction|diplomacy|negotiation|talks/.test(lower)) return 'cat2';
  if (/intelligence|spy|covert|operation/.test(lower)) return 'cat9';
  return 'cat1';
}

async function main() {
  console.log('Scraping Iran events from Google News RSS...');

  const allItems = new Map(); // dedupe by link

  for (const query of QUERIES) {
    console.log(`  ${query.replace(/\+/g, ' ')}...`);
    const items = await fetchGoogleNewsRss(query);
    for (const item of items) {
      if (!allItems.has(item.link)) {
        allItems.set(item.link, item);
      }
    }
    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  const events = [];
  for (const [link, item] of allItems) {
    events.push({
      id: Buffer.from(link).toString('base64url').slice(0, 20),
      title: item.title,
      category: categorize(item.title),
      link,
      time: relativeTime(item.pubDate),
    });
  }

  events.sort((a, b) => {
    const ta = a.time.includes('hour') ? parseInt(a.time, 10) : a.time.includes('day') ? parseInt(a.time, 10) * 24 : 999;
    const tb = b.time.includes('hour') ? parseInt(b.time, 10) : b.time.includes('day') ? parseInt(b.time, 10) * 24 : 999;
    return ta - tb;
  });

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(events, null, 2));
  console.log(`\n  Wrote ${events.length} events to ${OUTPUT}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
