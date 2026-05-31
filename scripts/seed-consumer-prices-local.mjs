#!/usr/bin/env node
/**
 * Seed consumer prices test data into Cloudflare KV.
 * Writes realistic mock data so the ConsumerPricesPanel renders
 * while the real consumer-prices-core pipeline is being set up.
 *
 * Usage: node scripts/seed-consumer-prices-local.mjs
 */

import { loadEnvFile, getKvBase, getKvToken } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const kvBase = getKvBase();
const kvToken = getKvToken();

const now = new Date().toISOString();

async function redisSet(key, value, ttlSeconds) {
  const resp = await fetch(`${kvBase}/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!resp.ok) console.error(`  FAIL ${key}: ${resp.status} ${await resp.text()}`);
}

function sparkline(base, variance, points = 14) {
  const pts = [];
  let v = base;
  for (let i = 0; i < points; i++) {
    v += (Math.random() - 0.48) * variance;
    pts.push(Math.round(v * 100) / 100);
  }
  return pts;
}

const MARKET = 'ae';
const BASKET = 'essentials-ae';
const TTL = 86400; // 24h

// --- Categories ---
const categories = [
  { slug: 'dairy', name: 'Dairy', wowPct: 0.3, momPct: 1.2, currentIndex: 101.2, coveragePct: 92, itemCount: 8 },
  { slug: 'bread', name: 'Bread & Bakery', wowPct: -0.1, momPct: 0.5, currentIndex: 100.5, coveragePct: 88, itemCount: 6 },
  { slug: 'rice', name: 'Rice & Grains', wowPct: 0.8, momPct: 2.1, currentIndex: 102.1, coveragePct: 95, itemCount: 10 },
  { slug: 'cooking_oil', name: 'Cooking Oil', wowPct: -1.2, momPct: -0.8, currentIndex: 99.2, coveragePct: 85, itemCount: 5 },
  { slug: 'chicken', name: 'Poultry', wowPct: 0.5, momPct: 1.8, currentIndex: 101.8, coveragePct: 90, itemCount: 7 },
  { slug: 'eggs', name: 'Eggs', wowPct: -0.3, momPct: 0.9, currentIndex: 100.9, coveragePct: 94, itemCount: 4 },
  { slug: 'vegetables', name: 'Fresh Vegetables', wowPct: 1.5, momPct: 3.2, currentIndex: 103.2, coveragePct: 78, itemCount: 12 },
  { slug: 'fruits', name: 'Fresh Fruits', wowPct: -0.7, momPct: -1.1, currentIndex: 98.9, coveragePct: 82, itemCount: 9 },
  { slug: 'water', name: 'Water & Beverages', wowPct: 0.0, momPct: 0.2, currentIndex: 100.2, coveragePct: 96, itemCount: 6 },
  { slug: 'cleaning', name: 'Cleaning Products', wowPct: 0.2, momPct: 0.7, currentIndex: 100.7, coveragePct: 87, itemCount: 8 },
].map((c) => ({ ...c, sparkline: sparkline(c.currentIndex, 0.5) }));

// --- Overview ---
const overview = {
  marketCode: MARKET,
  asOf: now,
  currencyCode: 'AED',
  essentialsIndex: 101.4,
  valueBasketIndex: 100.8,
  wowPct: 0.3,
  momPct: 1.1,
  retailerSpreadPct: 12.5,
  coveragePct: 89,
  freshnessLagMin: 45,
  topCategories: categories.slice(0, 5),
  upstreamUnavailable: false,
};

// --- Movers ---
const risers = [
  { productId: 'tomatoes_1kg', title: 'Tomatoes 1kg', category: 'vegetables', retailerSlug: 'lulu_ae', changePct: 8.2, currentPrice: 6.50, currencyCode: 'AED' },
  { productId: 'onions_1kg', title: 'Onions 1kg', category: 'vegetables', retailerSlug: 'carrefour_ae', changePct: 5.1, currentPrice: 4.75, currencyCode: 'AED' },
  { productId: 'chicken_whole_1kg', title: 'Whole Chicken 1kg', category: 'chicken', retailerSlug: 'lulu_ae', changePct: 3.4, currentPrice: 22.90, currencyCode: 'AED' },
  { productId: 'rice_basmati_1kg', title: 'Basmati Rice 1kg', category: 'rice', retailerSlug: 'spinneys_ae', changePct: 2.8, currentPrice: 14.50, currencyCode: 'AED' },
  { productId: 'eggs_12', title: 'Fresh Eggs 12 Pack', category: 'eggs', retailerSlug: 'lulu_ae', changePct: 1.9, currentPrice: 12.90, currencyCode: 'AED' },
  { productId: 'milk_1l', title: 'Full Fat Milk 1L', category: 'dairy', retailerSlug: 'carrefour_ae', changePct: 1.5, currentPrice: 5.75, currencyCode: 'AED' },
  { productId: 'yogurt_500g', title: 'Natural Yogurt 500g', category: 'dairy', retailerSlug: 'noon_grocery_ae', changePct: 1.2, currentPrice: 8.25, currencyCode: 'AED' },
  { productId: 'bread_white', title: 'White Bread 600g', category: 'bread', retailerSlug: 'adcoop_ae', changePct: 0.8, currentPrice: 4.50, currencyCode: 'AED' },
];
const fallers = [
  { productId: 'cooking_oil_1l', title: 'Sunflower Oil 1L', category: 'cooking_oil', retailerSlug: 'carrefour_ae', changePct: -4.2, currentPrice: 18.90, currencyCode: 'AED' },
  { productId: 'bananas_1kg', title: 'Bananas 1kg', category: 'fruits', retailerSlug: 'lulu_ae', changePct: -3.1, currentPrice: 6.50, currencyCode: 'AED' },
  { productId: 'potatoes_1kg', title: 'Potatoes 1kg', category: 'vegetables', retailerSlug: 'noon_grocery_ae', changePct: -2.5, currentPrice: 4.25, currencyCode: 'AED' },
  { productId: 'apples_1kg', title: 'Red Apples 1kg', category: 'fruits', retailerSlug: 'spinneys_ae', changePct: -1.8, currentPrice: 11.90, currencyCode: 'AED' },
  { productId: 'water_6pack', title: 'Mineral Water 6x1.5L', category: 'water', retailerSlug: 'carrefour_ae', changePct: -1.2, currentPrice: 8.50, currencyCode: 'AED' },
  { productId: 'sugar_1kg', title: 'White Sugar 1kg', category: 'rice', retailerSlug: 'lulu_ae', changePct: -0.9, currentPrice: 5.25, currencyCode: 'AED' },
  { productId: 'detergent_2l', title: 'Laundry Detergent 2L', category: 'cleaning', retailerSlug: 'adcoop_ae', changePct: -0.5, currentPrice: 22.50, currencyCode: 'AED' },
  { productId: 'cheese_200g', title: 'Cheddar Cheese 200g', category: 'dairy', retailerSlug: 'noon_grocery_ae', changePct: -0.3, currentPrice: 14.75, currencyCode: 'AED' },
];

const movers = { marketCode: MARKET, asOf: now, range: '30d', risers, fallers, upstreamUnavailable: false };

// --- Retailer spread ---
const retailers = [
  { slug: 'lulu_ae', name: 'Lulu Hypermarket', basketTotal: 142.35, deltaVsCheapest: 0, deltaVsCheapestPct: 0, itemCount: 28, freshnessMin: 35, currencyCode: 'AED' },
  { slug: 'carrefour_ae', name: 'Carrefour', basketTotal: 148.70, deltaVsCheapest: 6.35, deltaVsCheapestPct: 4.5, itemCount: 28, freshnessMin: 52, currencyCode: 'AED' },
  { slug: 'noon_grocery_ae', name: 'Noon Grocery', basketTotal: 153.20, deltaVsCheapest: 10.85, deltaVsCheapestPct: 7.6, itemCount: 26, freshnessMin: 68, currencyCode: 'AED' },
  { slug: 'adcoop_ae', name: 'ADCOOP', basketTotal: 155.90, deltaVsCheapest: 13.55, deltaVsCheapestPct: 9.5, itemCount: 25, freshnessMin: 90, currencyCode: 'AED' },
  { slug: 'spinneys_ae', name: 'Spinneys', basketTotal: 160.15, deltaVsCheapest: 17.80, deltaVsCheapestPct: 12.5, itemCount: 28, freshnessMin: 42, currencyCode: 'AED' },
];

const spread = { marketCode: MARKET, asOf: now, basketSlug: BASKET, currencyCode: 'AED', retailers, spreadPct: 12.5, upstreamUnavailable: false };

// --- Freshness ---
const freshness = {
  marketCode: MARKET, asOf: now,
  retailers: retailers.map((r) => ({ slug: r.slug, name: r.name, lastRunAt: now, status: r.freshnessMin <= 60 ? 'healthy' : 'degraded', parseSuccessRate: 92 + Math.random() * 7, freshnessMin: r.freshnessMin })),
  overallFreshnessMin: 45,
  stalledCount: 0,
  upstreamUnavailable: false,
};

// --- Write ---
console.log('Writing consumer prices seed data to Cloudflare KV...');
await redisSet(`consumer-prices:overview:${MARKET}`, overview, TTL);
console.log('  ✓ overview');
await redisSet(`consumer-prices:categories:${MARKET}:30d`, { marketCode: MARKET, asOf: now, range: '30d', categories, upstreamUnavailable: false }, TTL);
console.log('  ✓ categories');
await redisSet(`consumer-prices:movers:${MARKET}:30d`, movers, TTL);
console.log('  ✓ movers');
await redisSet(`consumer-prices:retailer-spread:${MARKET}:${BASKET}`, spread, TTL);
console.log('  ✓ retailer-spread');
await redisSet(`consumer-prices:freshness:${MARKET}`, freshness, TTL);
console.log('  ✓ freshness');
console.log('Done! Refresh the dashboard to see consumer prices data.');
