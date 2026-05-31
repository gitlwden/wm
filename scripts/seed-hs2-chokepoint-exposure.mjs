#!/usr/bin/env node

// @ts-check

import { createRequire } from 'node:module';
import {
  acquireLockSafely,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

/** @type {string} */
export const META_KEY = 'seed-meta:supply_chain:chokepoint-exposure';
/** @type {string} */
export const KEY_PREFIX = 'supply-chain:exposure:';
/** @type {number} */
export const TTL_SECONDS = 172800; // 48h — 2× daily cron interval
const LOCK_DOMAIN = 'supply_chain:chokepoint-exposure';
const LOCK_TTL_MS = 5 * 60 * 1000;
const COMTRADE_KEY_PREFIX = 'comtrade:bilateral-hs4:';

// Top 10 HS2 chapters by global trade volume and strategic importance.
const HS2_CODES = [
  '27', // Mineral Fuels (energy)
  '84', // Machinery & Mechanical Appliances
  '85', // Electrical Machinery & Electronics
  '87', // Vehicles
  '30', // Pharmaceuticals
  '72', // Iron & Steel
  '39', // Plastics
  '29', // Organic Chemicals
  '10', // Cereals (food security)
  '62', // Apparel (textiles)
];

// Lightweight copy of the chokepoint registry fields needed for exposure computation.
// Kept in sync with src/config/chokepoint-registry.ts — update both together.
/** @type {Array<{id: string, displayName: string, routeIds: string[], shockModelSupported: boolean}>} */
const CHOKEPOINT_REGISTRY = [
  { id: 'suez',            displayName: 'Suez Canal',            shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'malacca_strait',  displayName: 'Strait of Malacca',     shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-asia-oil','qatar-asia-lng','india-se-asia','china-africa','cpec-route'] },
  { id: 'hormuz_strait',   displayName: 'Strait of Hormuz',      shockModelSupported: true,  routeIds: ['gulf-europe-oil','gulf-asia-oil','qatar-europe-lng','qatar-asia-lng','gulf-americas-cape'] },
  { id: 'bab_el_mandeb',   displayName: 'Bab el-Mandeb',         shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'panama',          displayName: 'Panama Canal',          shockModelSupported: false, routeIds: ['china-us-east-panama','panama-transit'] },
  { id: 'taiwan_strait',   displayName: 'Taiwan Strait',         shockModelSupported: false, routeIds: ['china-us-west','intra-asia-container'] },
  { id: 'cape_of_good_hope', displayName: 'Cape of Good Hope',   shockModelSupported: false, routeIds: ['brazil-china-bulk','gulf-americas-cape','asia-europe-cape'] },
  { id: 'gibraltar',       displayName: 'Strait of Gibraltar',   shockModelSupported: false, routeIds: ['gulf-europe-oil','singapore-med','india-europe','asia-europe-cape'] },
  { id: 'bosphorus',       displayName: 'Bosporus Strait',       shockModelSupported: false, routeIds: ['russia-med-oil'] },
  { id: 'korea_strait',    displayName: 'Korea Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'dover_strait',    displayName: 'Dover Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'kerch_strait',    displayName: 'Kerch Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'lombok_strait',   displayName: 'Lombok Strait',         shockModelSupported: false, routeIds: [] },
];

// ── Load country-port-clusters ────────────────────────────────────────────────

const require = createRequire(import.meta.url);
/** @type {Record<string, {nearestRouteIds: string[], coastSide: string}>} */
const COUNTRY_PORT_CLUSTERS = require('./shared/country-port-clusters.json');

// ── Exposure computation ──────────────────────────────────────────────────────

/**
 * @typedef {{ hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, year: number }} ComtradeProduct
 */

/**
 * Convert HS4 code to HS2 chapter (matches chokepoint-exposure-utils.ts:hs4ToHs2).
 * @param {string} hs4
 * @returns {string}
 */
function hs4ToHs2(hs4) {
  return String(Number.parseInt(hs4.slice(0, 2), 10));
}

/**
 * Flow-weighted exposure — mirrors chokepoint-exposure-utils.ts:computeFlowWeightedExposures.
 * Uses importerRoutes OR exporterRoutes union for route coverage (same as handler).
 * @param {string} importerIso2
 * @param {string} hs2
 * @param {ComtradeProduct[]} products
 * @returns {object[]}
 */
export function computeFlowWeightedExposures(importerIso2, hs2, products) {
  const isEnergy = hs2 === '27';
  const normalizedHs2 = String(Number.parseInt(hs2, 10));
  const matchingProducts = products.filter(p => hs4ToHs2(p.hs4) === normalizedHs2);

  if (matchingProducts.length === 0) return [];

  const importerCluster = COUNTRY_PORT_CLUSTERS[importerIso2];
  const importerRoutes = new Set(importerCluster?.nearestRouteIds ?? []);
  const totalSectorValue = matchingProducts.reduce((s, p) => s + p.totalValue, 0);

  /** @type {Map<string, number>} */
  const cpScores = new Map();
  for (const cp of CHOKEPOINT_REGISTRY) cpScores.set(cp.id, 0);

  for (const product of matchingProducts) {
    const productWeight = totalSectorValue > 0 ? product.totalValue / totalSectorValue : 0;

    for (const exporter of product.topExporters) {
      if (!exporter.partnerIso2) continue;
      const exporterCluster = COUNTRY_PORT_CLUSTERS[exporter.partnerIso2];
      const exporterRoutes = new Set(exporterCluster?.nearestRouteIds ?? []);

      for (const cp of CHOKEPOINT_REGISTRY) {
        let overlap = 0;
        for (const r of cp.routeIds) {
          if (importerRoutes.has(r) || exporterRoutes.has(r)) overlap++;
        }
        const routeCoverage = overlap / Math.max(cp.routeIds.length, 1);
        const contribution = routeCoverage * exporter.share * productWeight * 100;
        cpScores.set(cp.id, (cpScores.get(cp.id) ?? 0) + contribution);
      }
    }
  }

  const entries = CHOKEPOINT_REGISTRY.map(cp => {
    let score = cpScores.get(cp.id) ?? 0;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    score = Math.min(score, 100);
    return {
      chokepointId: cp.id,
      chokepointName: cp.displayName,
      exposureScore: Math.round(score * 10) / 10,
      coastSide: '',
      shockSupported: cp.shockModelSupported,
    };
  });

  return entries.sort((a, b) => b.exposureScore - a.exposureScore);
}

/**
 * Country-level route-based fallback — mirrors chokepoint-exposure-utils.ts:computeFallbackExposures.
 * @param {string[]} nearestRouteIds
 * @param {string} coastSide
 * @param {string} hs2
 * @returns {{ exposures: object[], primaryChokepointId: string, vulnerabilityIndex: number }}
 */
export function computeCountryLevelExposure(nearestRouteIds, coastSide, hs2) {
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);

  const entries = CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    return {
      chokepointId: cp.id,
      chokepointName: cp.displayName,
      exposureScore: Math.round(score * 10) / 10,
      shockSupported: cp.shockModelSupported,
    };
  }).sort((a, b) => b.exposureScore - a.exposureScore);

  if (entries[0]) entries[0] = { ...entries[0], coastSide };

  const weights = [0.5, 0.3, 0.2];
  const vulnerabilityIndex = Math.round(
    entries.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i], 0) * 10,
  ) / 10;

  return {
    exposures: entries,
    primaryChokepointId: entries[0]?.chokepointId ?? '',
    vulnerabilityIndex,
  };
}

// ── Redis pipeline helper ─────────────────────────────────────────────────────

/**
 * @param {Array<string[]>} commands
 */
async function redisPipeline(commands) {
  return cfPipeline(commands);
}