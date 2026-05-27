#!/usr/bin/env node

// Standalone classify seed — batch-classifies digest titles via LLM, writes
// per-title cache keys + threat summary to Upstash Redis.
// Extracted from ais-relay.cjs startClassifySeedLoop / seedClassify.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildEnvelope } from './_seed-envelope-source.mjs';
import { loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ── Redis helpers ─────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

async function redisSet(key, value, ttlSeconds, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const body = JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
      const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
        return false;
      }
      const data = await resp.json();
      return data?.result === 'OK';
    } catch (e) {
      if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
      return false;
    }
  }
  return false;
}

async function redisMGet(keys, retries = 3) {
  if (!keys.length) return [];
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = new URL('/pipeline', UPSTASH_URL);
      const body = JSON.stringify(keys.map((k) => ['GET', k]));
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
        return keys.map(() => null);
      }
      const parsed = await resp.json();
      return parsed.map((r) => {
        if (!r?.result) return null;
        try { return JSON.parse(r.result); } catch { return null; }
      });
    } catch {
      if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
      return keys.map(() => null);
    }
  }
  return keys.map(() => null);
}

function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const state = meta?.state || (recordCount === 0 && meta?.zeroOk ? 'OK_ZERO' : 'OK');
  const envelope = buildEnvelope({
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'classify-seed',
    schemaVersion: meta?.schemaVersion ?? 1,
    state,
    data,
  });
  return redisSet(key, envelope, ttlSeconds);
}

// ── Constants ─────────────────────────────────────────────────────────────

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CLASSIFY_CACHE_TTL = 86400;
const CLASSIFY_SKIP_TTL = 1800;
const CLASSIFY_BATCH_SIZE = 50;
const CLASSIFY_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity'];
const CLASSIFY_VARIANT_STAGGER_MS = 3 * 60 * 1000;

const NEWS_THREAT_SUMMARY_KEY = 'news:threat:summary:v1';
const NEWS_THREAT_SUMMARY_TTL = 1200;

// ── Source tiers (importance score) ───────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
let RELAY_SOURCE_TIERS = {};
for (const base of [join(__dirname, '..', 'shared'), join(__dirname, 'shared')]) {
  const p = join(base, 'source-tiers.json');
  if (existsSync(p)) { RELAY_SOURCE_TIERS = JSON.parse(readFileSync(p, 'utf8')); break; }
}

function relayGetSourceTier(sourceName) {
  return RELAY_SOURCE_TIERS[sourceName] ?? 4;
}

const RELAY_SCORE_WEIGHTS = { severity: 0.55, sourceTier: 0.2, corroboration: 0.15, recency: 0.1 };
const RELAY_SEVERITY_SCORES = { critical: 100, high: 75, medium: 50, low: 25, info: 0 };

function relayComputeImportanceScore(level, source, corroborationCount, publishedAt) {
  const tier = relayGetSourceTier(source);
  const tierScore = tier === 1 ? 100 : tier === 2 ? 75 : tier === 3 ? 50 : 25;
  const corroborationScore = Math.min(corroborationCount, 5) * 20;
  const ageMs = Date.now() - publishedAt;
  const recencyScore = Math.max(0, 1 - ageMs / (24 * 60 * 60 * 1000)) * 100;
  return Math.round(
    (RELAY_SEVERITY_SCORES[level] ?? 0) * RELAY_SCORE_WEIGHTS.severity +
    tierScore * RELAY_SCORE_WEIGHTS.sourceTier +
    corroborationScore * RELAY_SCORE_WEIGHTS.corroboration +
    recencyScore * RELAY_SCORE_WEIGHTS.recency,
  );
}

// ── Classification schema ─────────────────────────────────────────────────

const CLASSIFY_VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const CLASSIFY_VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

const CLASSIFY_SYSTEM_PROMPT = `You classify news headlines by threat level and category.
Return ONLY a JSON array, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Guidelines for LEVEL assignment (geopolitical scope required for critical):
- critical: Active military strikes with international implications, geopolitical mass-casualty events (10+ killed in conflict/terrorism/state action), ceasefire agreements/collapses, nuclear incidents, pandemic declarations, coups, strait/waterway closures
- high: Armed conflict updates, major diplomatic actions, sanctions packages, significant natural disasters, blockades, terrorist attacks, domestic mass-casualty events (mass shootings, industrial disasters)
- medium: Ongoing conflict analysis, economic impact reports, protest movements, regional policy changes, military exercises
- low: Diplomatic meetings, trade discussions, humanitarian aid, election updates, peacekeeping deployments
- info: Opinion/editorial pieces, analysis/explainer articles, historical retrospectives, lifestyle, entertainment, routine local news, tutorials

Key distinction: "critical" requires GEOPOLITICAL scope — events that destabilize international order, threaten cross-border security, or disrupt global systems. Domestic tragedies are "high" unless they trigger international diplomatic responses.

Input: numbered lines "index|Title"
Output: [{"i":0,"l":"high","c":"conflict"}, ...]

Focus: geopolitical events, conflicts, disasters, diplomacy.
Classify by real-world event severity, not headline sentiment.`;

// ── Cache key ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

function classifyCacheKey(title) {
  const hash = createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 16);
  return `classify:sebuf:v5:${hash}`;
}

// ── Country name matching (threat summary) ────────────────────────────────

const THREAT_COUNTRY_NAME_TO_ISO2 = {
  'afghanistan':'AF','albania':'AL','algeria':'DZ','angola':'AO','argentina':'AR',
  'armenia':'AM','australia':'AU','austria':'AT','azerbaijan':'AZ','bahrain':'BH',
  'bangladesh':'BD','belarus':'BY','belgium':'BE','bolivia':'BO','brazil':'BR',
  'burkina faso':'BF','burma':'MM','cambodia':'KH','cameroon':'CM','canada':'CA',
  'chad':'TD','chile':'CL','china':'CN','colombia':'CO','congo':'CG',
  'costa rica':'CR','croatia':'HR','cuba':'CU','cyprus':'CY',
  'czech republic':'CZ','czechia':'CZ',
  'democratic republic of the congo':'CD','dr congo':'CD','drc':'CD',
  'denmark':'DK','djibouti':'DJ','dominican republic':'DO',
  'ecuador':'EC','egypt':'EG','el salvador':'SV','eritrea':'ER',
  'estonia':'EE','ethiopia':'ET','finland':'FI','france':'FR',
  'georgia':'GE','germany':'DE','ghana':'GH','greece':'GR',
  'guatemala':'GT','guinea':'GN','haiti':'HT','honduras':'HN','hungary':'HU',
  'iceland':'IS','india':'IN','indonesia':'ID','iran':'IR','iraq':'IQ',
  'ireland':'IE','israel':'IL','italy':'IT','ivory coast':'CI',
  'jamaica':'JM','japan':'JP','jordan':'JO','kazakhstan':'KZ',
  'kenya':'KE','kosovo':'XK','kuwait':'KW','kyrgyzstan':'KG',
  'laos':'LA','latvia':'LV','lebanon':'LB','libya':'LY','lithuania':'LT',
  'mali':'ML','mauritania':'MR','mexico':'MX','moldova':'MD',
  'mongolia':'MN','montenegro':'ME','morocco':'MA','mozambique':'MZ',
  'myanmar':'MM','namibia':'NA','nepal':'NP','netherlands':'NL',
  'new zealand':'NZ','nicaragua':'NI','niger':'NE','nigeria':'NG',
  'north korea':'KP','north macedonia':'MK','norway':'NO',
  'oman':'OM','pakistan':'PK','palestine':'PS','panama':'PA',
  'paraguay':'PY','peru':'PE','philippines':'PH','poland':'PL',
  'portugal':'PT','qatar':'QA','romania':'RO','russia':'RU','rwanda':'RW',
  'saudi arabia':'SA','senegal':'SN','serbia':'RS','sierra leone':'SL',
  'singapore':'SG','slovakia':'SK','slovenia':'SI','somalia':'SO',
  'south africa':'ZA','south korea':'KR','south sudan':'SS','spain':'ES',
  'sri lanka':'LK','sudan':'SD','sweden':'SE','switzerland':'CH',
  'syria':'SY','taiwan':'TW','tajikistan':'TJ','tanzania':'TZ',
  'thailand':'TH','togo':'TG','tunisia':'TN','turkey':'TR',
  'turkmenistan':'TM','uganda':'UG','ukraine':'UA',
  'united arab emirates':'AE','uae':'AE',
  'united kingdom':'GB','uk':'GB','united states':'US','usa':'US',
  'uruguay':'UY','uzbekistan':'UZ','venezuela':'VE','vietnam':'VN',
  'yemen':'YE','zambia':'ZM','zimbabwe':'ZW',
  'tehran':'IR','moscow':'RU','beijing':'CN','kyiv':'UA','pyongyang':'KP',
  'tel aviv':'IL','gaza':'PS','damascus':'SY','sanaa':'YE','houthi':'YE',
  'kremlin':'RU','pentagon':'US','nato':'','irgc':'IR','hezbollah':'LB',
  'hamas':'PS','taliban':'AF','riyadh':'SA','ankara':'TR',
};

const THREAT_COUNTRY_NAME_ENTRIES = Object.entries(THREAT_COUNTRY_NAME_TO_ISO2)
  .filter(([name, iso2]) => name.length >= 3 && iso2.length === 2)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, iso2]) => ({ name, iso2, regex: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

const AFFECTED_PREFIX_RE = /\b(in|on|against|at|into|across|inside|targeting|toward[s]?|invad(?:es?|ed|ing)|attack(?:s|ed|ing)?|bomb(?:s|ed|ing)?|hitt?(?:ing|s)?|strik(?:es?|ing))\s+(?:the\s+)?/gi;

function matchCountryNamesInText(text) {
  const lower = text.toLowerCase();
  let match;
  AFFECTED_PREFIX_RE.lastIndex = 0;
  while ((match = AFFECTED_PREFIX_RE.exec(lower)) !== null) {
    const afterPfx = lower.slice(match.index + match[0].length);
    for (const { name, iso2 } of THREAT_COUNTRY_NAME_ENTRIES) {
      if (afterPfx.startsWith(name) && (afterPfx.length === name.length || /\W/.test(afterPfx[name.length]))) {
        return [iso2];
      }
    }
  }
  return [];
}

// ── LLM provider chain ───────────────────────────────────────────────────

const CLASSIFY_LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 30000,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }),
    timeout: 30000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.5-flash',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    timeout: 30000,
  },
];

function classifyFetchLlmSingle(titles, _apiKey, apiUrl, model, headers, extraBody, timeout) {
  return new Promise((resolve) => {
    const sanitized = titles.map((t) => t.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, 200).trim());
    const prompt = sanitized.map((t, i) => `${i}|${t}`).join('\n');
    const bodyStr = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: titles.length * 40,
      ...extraBody,
    });

    const parsed = new URL(apiUrl);
    fetch(apiUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(bodyStr)) },
      body: bodyStr,
      signal: AbortSignal.timeout(timeout),
    })
      .then(async (resp) => {
        if (!resp.ok) return resolve(null);
        const data = await resp.json();
        const raw = data?.choices?.[0]?.message?.content?.trim();
        if (!raw) return resolve(null);
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) return resolve(null);
        resolve(JSON.parse(match[0]));
      })
      .catch(() => resolve(null));
  });
}

async function classifyFetchLlm(titles) {
  for (const provider of CLASSIFY_LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const headers = provider.headers(envVal);

    const result = await classifyFetchLlmSingle(titles, envVal, apiUrl, model, headers, provider.extraBody || {}, provider.timeout);
    if (result) return result;
    console.warn(`[Classify] ${provider.name} failed, trying next provider...`);
  }
  return null;
}

// ── Per-variant classify ──────────────────────────────────────────────────

async function seedClassifyForVariant(variant, seenTitles) {
  const digestUrl = `https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=${variant}&lang=en`;
  let digest;
  try {
    const resp = await fetch(digestUrl, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { total: 0, classified: 0, skipped: 0 };
    digest = await resp.json();
  } catch {
    return { total: 0, classified: 0, skipped: 0 };
  }

  const RECENCY_GATE_MS = 6 * 60 * 60 * 1000;
  const now6h = Date.now() - RECENCY_GATE_MS;
  const allTitles = new Map();
  if (digest?.categories) {
    for (const bucket of Object.values(digest.categories)) {
      for (const item of bucket?.items ?? []) {
        if (!item?.title) continue;
        if (item.publishedAt && item.publishedAt < now6h) continue;
        if (!allTitles.has(item.title)) {
          allTitles.set(item.title, {
            source: item.source ?? variant,
            publishedAt: item.publishedAt ?? Date.now(),
            corroborationCount: item.corroborationCount ?? 1,
            link: item.link ?? '',
          });
        }
      }
    }
  }
  if (allTitles.size === 0) return { total: 0, classified: 0, skipped: 0 };

  const titleArr = [...allTitles.keys()];
  const cacheKeys = titleArr.map((t) => classifyCacheKey(t));

  const cached = await redisMGet(cacheKeys);
  const misses = [];
  const byCountry = {};
  const emptyLevel = () => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

  for (let i = 0; i < titleArr.length; i++) {
    const hit = cached[i];
    if (!hit) {
      misses.push(titleArr[i]);
      continue;
    }
    let parsed = hit;
    if (typeof hit === 'string') { try { parsed = JSON.parse(hit); } catch { continue; } }
    const level = parsed?.level;
    if (!CLASSIFY_VALID_LEVELS.includes(level)) continue;
    if (seenTitles.has(titleArr[i])) continue;
    seenTitles.add(titleArr[i]);
    for (const code of matchCountryNamesInText(titleArr[i])) {
      if (!byCountry[code]) byCountry[code] = emptyLevel();
      byCountry[code][level]++;
    }
  }

  if (misses.length === 0) return { total: titleArr.length, classified: 0, skipped: 0, byCountry };

  let classified = 0;
  let skipped = 0;

  for (let b = 0; b < misses.length; b += CLASSIFY_BATCH_SIZE) {
    const chunk = misses.slice(b, b + CLASSIFY_BATCH_SIZE);
    const llmResult = await classifyFetchLlm(chunk);

    if (!Array.isArray(llmResult)) {
      for (const title of chunk) {
        await redisSet(classifyCacheKey(title), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
      continue;
    }

    const classifiedSet = new Set();
    for (const entry of llmResult) {
      const idx = entry?.i;
      if (typeof idx !== 'number' || idx < 0 || idx >= chunk.length) continue;
      if (classifiedSet.has(idx)) continue;
      const level = CLASSIFY_VALID_LEVELS.includes(entry?.l) ? entry.l : null;
      const category = CLASSIFY_VALID_CATEGORIES.includes(entry?.c) ? entry.c : null;
      if (!level || !category) continue;
      classifiedSet.add(idx);
      await redisSet(classifyCacheKey(chunk[idx]), { level, category, timestamp: Date.now() }, CLASSIFY_CACHE_TTL);
      classified++;
      if (!seenTitles.has(chunk[idx])) {
        seenTitles.add(chunk[idx]);
        for (const code of matchCountryNamesInText(chunk[idx])) {
          if (!byCountry[code]) byCountry[code] = emptyLevel();
          byCountry[code][level]++;
        }
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      if (!classifiedSet.has(i)) {
        await redisSet(classifyCacheKey(chunk[i]), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
    }
  }

  return { total: titleArr.length, classified, skipped, byCountry };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const hasAnyProvider = CLASSIFY_LLM_PROVIDERS.some((p) => !!process.env[p.envKey]);
  if (!hasAnyProvider) {
    console.log('[Classify] Skipped — no LLM provider keys configured');
    process.exit(0);
  }

  console.log('[Classify] Seed starting...');
  const t0 = Date.now();

  let totalClassified = 0;
  let totalSkipped = 0;
  const mergedByCountry = {};
  const seenTitles = new Set();

  for (let v = 0; v < CLASSIFY_VARIANTS.length; v++) {
    if (v > 0) await new Promise((r) => setTimeout(r, CLASSIFY_VARIANT_STAGGER_MS));
    try {
      const stats = await seedClassifyForVariant(CLASSIFY_VARIANTS[v], seenTitles);
      totalClassified += stats.classified;
      totalSkipped += stats.skipped;
      console.log(`[Classify] ${CLASSIFY_VARIANTS[v]}: ${stats.total} titles, ${stats.classified} classified, ${stats.skipped} skipped`);
      for (const [code, counts] of Object.entries(stats.byCountry || {})) {
        if (!mergedByCountry[code]) mergedByCountry[code] = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        for (const lvl of ['critical', 'high', 'medium', 'low', 'info']) {
          mergedByCountry[code][lvl] += counts[lvl] || 0;
        }
      }
    } catch (e) {
      console.warn(`[Classify] ${CLASSIFY_VARIANTS[v]} error:`, e?.message || e);
    }
  }

  // Write threat summary
  const countryKeys = Object.keys(mergedByCountry);
  await redisSet('seed-meta:news:threat-summary', { fetchedAt: Date.now(), recordCount: countryKeys.length }, 604800);
  if (countryKeys.length > 0) {
    await envelopeWrite(NEWS_THREAT_SUMMARY_KEY, { byCountry: mergedByCountry, generatedAt: Date.now() }, NEWS_THREAT_SUMMARY_TTL, { recordCount: countryKeys.length, sourceVersion: 'news-threat-summary' });
    console.log(`[Classify] Threat summary written for ${countryKeys.length} countries`);
  }

  await redisSet('seed-meta:classify', { fetchedAt: Date.now(), recordCount: totalClassified }, 604800);
  console.log(`[Classify] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalClassified} classified, ${totalSkipped} skipped`);
}

main().catch((e) => {
  console.error('[Classify] Fatal error:', e?.message || e);
  process.exit(1);
});
