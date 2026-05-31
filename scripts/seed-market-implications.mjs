#!/usr/bin/env node
/**
 * Seed Market Implications — AI analysis of current market conditions.
 * Fetches market data, sends to LLM, stores analysis.
 * Writes to Redis key: intelligence:market-implications:v1
 */
import { loadEnvFile, CHROME_UA, runSeed, getKvBase, getKvToken } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:market-implications:v1';
const TTL = 14400; // 4h

const AI_PROVIDERS = [
  { name: 'nvidia', envKey: 'NVIDIA_NIM_API_KEY', apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.3-70b-instruct', timeout: 30_000 },
  { name: 'cerebras', envKey: 'CEREBRAS_API_KEY', apiUrl: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama3.1-8b', timeout: 20_000 },
  { name: 'sambanova', envKey: 'SAMBANOVA_API_KEY', apiUrl: 'https://api.sambanova.ai/v1/chat/completions', model: 'Meta-Llama-3.1-8B-Instruct', timeout: 20_000 },
];

function redisSet(url, token, key, value, ttlSeconds) {
  return fetch(`${url}/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(15000) })
    .then(r => r.ok);
}

async function fetchMarketData() {
  const sectors = ['SPY', 'QQQ', 'XLF', 'XLE', 'XLK', 'XLV', 'XLU', 'GLD', 'TLT', 'VIX'];
  const data = [];
  for (const sym of sectors) {
    try {
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`, {
        headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta) {
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        const change = prev ? ((price - prev) / prev * 100).toFixed(2) : 'N/A';
        data.push({ symbol: sym, price: price?.toFixed(2), change: `${change}%` });
      }
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return data;
}

async function callAI(prompt, provider) {
  const apiKey = process.env[provider.envKey];
  if (!apiKey) return null;
  try {
    const resp = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: 'You are a financial analyst. Respond ONLY with valid JSON array. Each item: {"ticker":"...","name":"...","direction":"bullish|bearish|neutral","timeframe":"short|medium|long","confidence":"high|medium|low","title":"...","narrative":"...","riskCaveat":"...","driver":"..."}. Max 6 items. No markdown.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(provider.timeout),
    });
    if (!resp.ok) { console.warn(`  ${provider.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) { console.warn(`  ${provider.name}: ${e.message}`); return null; }
}

export function declareRecords(data) {
  return Array.isArray(data?.cards) ? data.cards.length : 0;
}

async function fetchMarketImplications() {
  console.log('  Fetching market data...');
  const marketData = await fetchMarketData();
  if (marketData.length < 5) throw new Error('Insufficient market data');

  const prompt = `Based on these current market conditions, identify the top market implications:\n${JSON.stringify(marketData, null, 2)}\n\nReturn a JSON array of up to 6 market implication cards with ticker, name, direction, timeframe, confidence, title, narrative (1-2 sentences), riskCaveat, and driver fields.`;

  let cards = null;
  for (const provider of AI_PROVIDERS) {
    console.log(`  Trying ${provider.name}...`);
    cards = await callAI(prompt, provider);
    if (Array.isArray(cards) && cards.length > 0) break;
  }

  if (!cards || cards.length === 0) throw new Error('All AI providers failed');

  return {
    cards: cards.slice(0, 6).map((c, i) => ({
      ticker: c.ticker ?? '',
      name: c.name ?? '',
      direction: c.direction ?? 'neutral',
      timeframe: c.timeframe ?? 'medium',
      confidence: c.confidence ?? 'medium',
      title: c.title ?? '',
      narrative: c.narrative ?? '',
      riskCaveat: c.riskCaveat ?? '',
      driver: c.driver ?? '',
      transmissionChain: [],
    })),
    degraded: false,
    emptyReason: '',
    generatedAt: new Date().toISOString(),
  };
}

await runSeed('intelligence', 'market-implications', CANONICAL_KEY, fetchMarketImplications, {
  ttlSeconds: TTL,
  sourceVersion: 'llm-v1',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 240,
}).catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
