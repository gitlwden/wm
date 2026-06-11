#!/usr/bin/env node

// Standalone Dodo product prices seed — fetches live prices from Dodo Payments
// API, builds tier view model, writes to Cloudflare KV.
// Extracted from ais-relay.cjs startDodoPriceSeedLoop / seedDodoPrices.

import { buildEnvelope } from './_seed-envelope-source.mjs';
import { loadEnvFile, kvSet } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ── KV helpers ─────────────────────────────────────────────────────────

async function redisSet(key, value, ttlSeconds) {
  try {
    await kvSet(key, value, ttlSeconds);
    return true;
  } catch { return false; }
}

function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const state = meta?.state || (recordCount === 0 && meta?.zeroOk ? 'OK_ZERO' : 'OK');
  const envelope = buildEnvelope({
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'dodo-prices',
    schemaVersion: meta?.schemaVersion ?? 1,
    state,
    data,
  });
  return redisSet(key, envelope, ttlSeconds);
}

// ── Constants ─────────────────────────────────────────────────────────────

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const DODO_PRICE_SEED_TTL = 43200; // 12h
const DODO_PRICE_REDIS_KEY = 'product-catalog:v2';
const DODO_LIVE_URL = 'https://live.dodopayments.com';
const DODO_TEST_URL = 'https://test.dodopayments.com';
const DODO_PRICE_API_KEY = process.env.DODO_API_KEY || '';
const DODO_PRICE_ENV = process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode';

const DODO_PRODUCT_IDS = [
  'pdt_0Nbtt71uObulf7fGXhQup', // Pro Monthly
  'pdt_0NbttMIfjLWC10jHQWYgJ', // Pro Annual
  'pdt_0NbttVmG1SERrxhygbbUq', // API Starter Monthly
  'pdt_0Nbu2lawHYE3dv2THgSEV', // API Starter Annual
];

const DODO_TIER_CONFIG = {
  free: { name: 'Free', description: 'Get started with the essentials', features: ['Core dashboard panels', 'Global news feed', 'Earthquake & weather alerts', 'Basic map view'], cta: 'Get Started', href: 'https://wm-worldmonitor.netlify.app', highlighted: false },
  pro: { name: 'Pro', description: 'Full intelligence dashboard', features: ['Everything in Free', 'AI stock analysis & backtesting', 'Daily market briefs', 'Military & geopolitical tracking', 'Custom widget builder', 'MCP data connectors', 'Priority data refresh'], highlighted: true },
  api_starter: { name: 'API', description: 'Programmatic access to intelligence data', features: ['REST API access', 'Real-time data streams', '1,000 requests/day', 'Webhook notifications', 'Custom data exports'], highlighted: false },
  enterprise: { name: 'Enterprise', description: 'Custom solutions for organizations', features: ['Everything in Pro + API', 'Unlimited API requests', 'Dedicated support', 'Custom integrations', 'SLA guarantee', 'On-premise option'], cta: 'Contact Sales', href: 'mailto:enterprise@wm-worldmonitor.netlify.app', highlighted: false },
};

const DODO_PRODUCT_META = {
  'pdt_0Nbtt71uObulf7fGXhQup': { tierGroup: 'pro', billingPeriod: 'monthly' },
  'pdt_0NbttMIfjLWC10jHQWYgJ': { tierGroup: 'pro', billingPeriod: 'annual' },
  'pdt_0NbttVmG1SERrxhygbbUq': { tierGroup: 'api_starter', billingPeriod: 'monthly' },
  'pdt_0Nbu2lawHYE3dv2THgSEV': { tierGroup: 'api_starter', billingPeriod: 'annual' },
};

const DODO_FALLBACK_PRICES = {
  'pdt_0Nbtt71uObulf7fGXhQup': 3999,
  'pdt_0NbttMIfjLWC10jHQWYgJ': 39999,
  'pdt_0NbttVmG1SERrxhygbbUq': 9999,
  'pdt_0Nbu2lawHYE3dv2THgSEV': 99900,
};

// ── Fetch helpers ─────────────────────────────────────────────────────────

async function fetchDodoProductPrice(productId, baseUrl) {
  const resp = await fetch(`${baseUrl}/products/${productId}`, {
    headers: { Authorization: `Bearer ${DODO_PRICE_API_KEY}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const product = await resp.json();
  return product.price?.price ?? product.price?.fixed_price ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!DODO_PRICE_API_KEY) {
    console.warn('[DodoPrices] No DODO_API_KEY — skipping');
    process.exit(0);
  }

  console.log('[DodoPrices] Seed starting...');
  const t0 = Date.now();

  const baseUrl = DODO_PRICE_ENV === 'live_mode' ? DODO_LIVE_URL : DODO_TEST_URL;
  const prices = {};
  let fetchedCount = 0;
  let fallbackCount = 0;

  for (const productId of DODO_PRODUCT_IDS) {
    try {
      const priceCents = await fetchDodoProductPrice(productId, baseUrl);
      if (priceCents != null) { prices[productId] = priceCents; fetchedCount++; continue; }
    } catch (e) {
      console.warn(`[DodoPrices] Fetch ${productId} failed: ${e?.message}`);
    }

    // Use fallback
    if (DODO_FALLBACK_PRICES[productId] != null) {
      prices[productId] = DODO_FALLBACK_PRICES[productId];
      fallbackCount++;
    }
  }

  // Build tier view model
  const tiers = [];
  const publicGroups = ['free', 'pro', 'api_starter', 'enterprise'];
  for (const group of publicGroups) {
    const config = DODO_TIER_CONFIG[group];
    if (!config) continue;
    if (group === 'free') { tiers.push({ ...config, price: 0, period: 'forever' }); continue; }
    if (group === 'enterprise') { tiers.push({ ...config, price: null }); continue; }

    const tier = { ...config };
    const monthlyId = Object.entries(DODO_PRODUCT_META).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'monthly')?.[0];
    const annualId = Object.entries(DODO_PRODUCT_META).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'annual')?.[0];
    if (monthlyId && prices[monthlyId]) { tier.monthlyPrice = prices[monthlyId] / 100; tier.monthlyProductId = monthlyId; }
    if (annualId && prices[annualId]) { tier.annualPrice = prices[annualId] / 100; tier.annualProductId = annualId; }
    tiers.push(tier);
  }

  const priceSource = fallbackCount === 0 ? 'dodo' : fetchedCount > 0 ? 'partial' : 'fallback';
  const now = Date.now();
  const payload = { tiers, fetchedAt: now, cachedUntil: now + DODO_PRICE_SEED_TTL * 1000, priceSource };

  // Only write to KV when ALL prices came from Dodo (no fallback contamination).
  if (priceSource === 'dodo') {
    const ok1 = await envelopeWrite(DODO_PRICE_REDIS_KEY, payload, DODO_PRICE_SEED_TTL, { recordCount: fetchedCount, sourceVersion: 'dodo-prices' });
    const ok2 = await redisSet('seed-meta:product-catalog', { fetchedAt: now, recordCount: fetchedCount, priceSource }, 604800);
    console.log(`[DodoPrices] Seeded ${fetchedCount}/${DODO_PRODUCT_IDS.length} from Dodo (kv=${ok1 && ok2 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.warn(`[DodoPrices] NOT writing to KV — source=${priceSource} (${fetchedCount} live, ${fallbackCount} fallback) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

main().catch((e) => {
  console.error('[DodoPrices] Fatal error:', e?.message || e);
  process.exit(1);
});
