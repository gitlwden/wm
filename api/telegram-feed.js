// @ts-check
import { getCorsHeaders } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

// ── Channel map: topic → channel usernames ──────────────────────────
const CHANNELS = {
  breaking: [
    'liveuamap',          // Live Universal Awareness Map
    'Flash_news_ua',      // Flash News UA
    'OSINTdefender',      // OSINTdefender
    'nexta_live',         // NEXTA Live
  ],
  conflict: [
    'rybar',              // Rybar (Russian milblogger)
    'wargonzo',           // WarGonzo
    'ukraine_war_report',
    'tass_agency',        // TASS (Russian state)
    'OSINTdefender',
  ],
  geopolitics: [
    'DDGeopolitics',
    'IntelRepublic',
    'TheEurasianist',
    'novorossia_today',
    'ghost_of_novorossiya',
  ],
  middleeast: [
    'Middle_East_Spectator',
    'IranIntl',
    'MiddleEastEye',
    'syriahm',
  ],
  osint: [
    'wartranslated',      // War Translated (OSINT)
    'IntelSky',           // Intel Sky
    'UAWeapons',          // Ukraine Weapons Tracker
    'OSINTdefender',      // OSINTdefender
    'osinttv',            // OSINT TV
  ],
  cyber: [
    'vxunderground',      // vx-underground
    'cyberknow',          // CyberKnow
    'malwrhunterteam',    // Malware Hunter
    'cyberwarzone',       // Cyber War Zone
  ],
};

// Flatten unique channels across all topics
const ALL_CHANNELS = [...new Set(Object.values(CHANNELS).flat())];

// ── Telegram HTML parser ────────────────────────────────────────────

/**
 * Parse Telegram web-preview HTML into message objects.
 * @param {string} channel
 * @param {string} html
 * @returns {{ messages: Array<{id:string,channel:string,ts:string,text:string,mediaUrls:string[]}>, minId:number|null }}
 */
function parseMessages(channel, html) {
  const blocks = html.split('data-post="');
  const messages = [];
  let minId = null;

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    // data-post="channel/12345"  — extract channel/ID
    const dpMatch = block.match(/^([^"]+\/(\d+))/);
    if (!dpMatch) continue;
    const numericId = parseInt(dpMatch[2], 10);
    if (!Number.isFinite(numericId)) continue;
    if (minId === null || numericId < minId) minId = numericId;

    // datetime from <time datetime="...">
    const timeMatch = block.match(/datetime="([^"]+)"/);
    const ts = timeMatch ? new Date(timeMatch[1]).toISOString() : new Date(0).toISOString();

    // message text from tgme_widget_message_text
    let text = '';
    const textStart = block.indexOf('tgme_widget_message_text');
    if (textStart !== -1) {
      const divStart = block.indexOf('>', textStart);
      if (divStart !== -1) {
        // Find the matching closing </div> — skip nested divs
        let depth = 1;
        let pos = divStart + 1;
        while (pos < block.length && depth > 0) {
          if (block.startsWith('<div', pos)) { depth++; pos += 4; }
          else if (block.startsWith('</div>', pos)) { depth--; pos += 6; }
          else pos++;
        }
        if (depth === 0) {
          text = block.slice(divStart + 1, pos - 6);
        }
      }
    }

    // Clean HTML → plain text
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim();

    // Extract media URLs (images)
    const mediaUrls = [];
    const imgRegex = /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"]*)?)"/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(block)) !== null) {
      if (!mediaUrls.includes(imgMatch[1])) mediaUrls.push(imgMatch[1]);
    }
    // Also check background-image: url(...)
    const bgRegex = /background-image:\s*url\(['"]?(https?:\/\/[^'")\s]+)['"]?\)/gi;
    let bgMatch;
    while ((bgMatch = bgRegex.exec(block)) !== null) {
      if (!mediaUrls.includes(bgMatch[1])) mediaUrls.push(bgMatch[1]);
    }

    messages.push({
      id: `${channel}/${numericId}`,
      channel,
      ts,
      text,
      mediaUrls,
    });
  }

  return { messages, minId };
}

// ── Rate limiter ────────────────────────────────────────────────────

/**
 * Run promises with bounded concurrency.
 * @template T
 * @param {(() => Promise<T>)[]} tasks
 * @param {number} limit
 * @returns {Promise<(T | null)[]>}
 */
async function parallelLimit(tasks, limit) {
  const results = new Array(tasks.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

// ── Per-channel scraper ─────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Fetch latest messages from a single Telegram channel via web preview.
 * @param {string} channel
 * @param {number} limit
 * @returns {Promise<{channel:string, messages:Array<{id:string,channel:string,ts:string,text:string,mediaUrls:string[]}>} | null>}
 */
async function scrapeChannel(channel, limit) {
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const html = await res.text();
  const { messages } = parseMessages(channel, html);
  return { channel, messages: messages.slice(0, limit) };
}

// ── Edge handler ────────────────────────────────────────────────────

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    const topicParam = (url.searchParams.get('topic') || '').trim();

    // Determine which channels to scrape
    const topicsToFetch = !topicParam || topicParam === 'all'
      ? Object.keys(CHANNELS)
      : CHANNELS[topicParam]
        ? [topicParam]
        : Object.keys(CHANNELS);

    const channels = [...new Set(topicsToFetch.flatMap(t => CHANNELS[t] || []))];

    if (channels.length === 0) {
      return jsonResponse({ enabled: true, count: 0, items: [], updatedAt: new Date().toISOString() }, 200, {
        'Cache-Control': 'public, max-age=30, s-maxage=120, stale-while-revalidate=60',
        ...corsHeaders,
      });
    }

    // Build topic lookup: channel → topic
    const channelTopicMap = new Map();
    for (const [topic, chans] of Object.entries(CHANNELS)) {
      for (const ch of chans) {
        // First assignment wins (priority order)
        if (!channelTopicMap.has(ch)) channelTopicMap.set(ch, topic);
      }
    }

    // Scrape all channels concurrently (max 6 at a time)
    const tasks = channels.map(ch => () => scrapeChannel(ch, limit));
    const results = await parallelLimit(tasks, 6);

    // Merge, tag topics, sort by timestamp (newest first)
    const items = [];
    for (const r of results) {
      if (!r) continue;
      const topic = channelTopicMap.get(r.channel) || 'osint';
      for (const msg of r.messages) {
        items.push({
          id: msg.id,
          source: 'telegram',
          channel: msg.channel,
          channelTitle: msg.channel,
          url: `https://t.me/${msg.channel}/${msg.id.split('/').pop()}`,
          ts: msg.ts,
          text: msg.text,
          topic,
          tags: [],
          earlySignal: false,
          mediaUrls: msg.mediaUrls,
        });
      }
    }

    items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    const trimmed = items.slice(0, limit);

    const cacheControl = trimmed.length === 0
      ? 'public, max-age=0, s-maxage=15, stale-while-revalidate=10'
      : 'public, max-age=60, s-maxage=180, stale-while-revalidate=60';

    return jsonResponse({
      source: 'telegram',
      earlySignal: false,
      enabled: true,
      count: trimmed.length,
      updatedAt: new Date().toISOString(),
      items: trimmed,
    }, 200, { 'Cache-Control': cacheControl, ...corsHeaders });

  } catch (error) {
    return jsonResponse({
      error: 'Telegram scrape failed',
      details: String(error?.message || error),
    }, 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
