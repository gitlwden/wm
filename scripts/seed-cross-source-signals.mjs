#!/usr/bin/env node
import { loadEnvFile, runSeed, getRedisCredentials , cfPipeline } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:cross-source-signals:v1';
const CACHE_TTL = 1800; // 30min TTL, 15min cron cadence

// ── Source Redis keys ─────────────────────────────────────────────────────────
const SOURCE_KEYS = [
  'thermal:escalation:v1',
  'intelligence:gpsjam:v2',
  'military:flights:v1',
  'unrest:events:v1',
  'intelligence:advisories-bootstrap:v1',
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'cyber:threats-bootstrap:v2',
  'supply_chain:shipping:v2',
  'sanctions:pressure:v1',
  'seismology:earthquakes:v1',
  'radiation:observations:v1',
  'infra:outages:v1',
  'wildfire:fires:v1',
  `displacement:summary:v1:${new Date().getFullYear()}`,
  'forecast:predictions:v2',
  'intelligence:gdelt-intel:v1',
  'gdelt:intel:tone:military',
  'gdelt:intel:tone:nuclear',
  'gdelt:intel:tone:maritime',
  'weather:alerts:v1',
  'risk:scores:sebuf:stale:v1',
  'regulatory:actions:v1',
];

// ── Theater classification helpers ────────────────────────────────────────────
const REGION_THEATER_MAP = {
  'eastern europe': 'Eastern Europe',
  'ukraine': 'Eastern Europe',
  'russia': 'Eastern Europe',
  'belarus': 'Eastern Europe',
  'middle east': 'Middle East',
  'israel': 'Middle East',
  'gaza': 'Middle East',
  'iran': 'Middle East',
  'iraq': 'Middle East',
  'syria': 'Middle East',
  'lebanon': 'Middle East',
  'yemen': 'Middle East',
  'saudi': 'Middle East',
  'red sea': 'Red Sea',
  'gulf of aden': 'Red Sea',
  'persian gulf': 'Persian Gulf',
  'strait of hormuz': 'Persian Gulf',
  'east asia': 'East Asia',
  'south china sea': 'East Asia',
  'taiwan': 'East Asia',
  'korea': 'East Asia',
  'china': 'East Asia',
  'japan': 'East Asia',
  'south asia': 'South Asia',
  'india': 'South Asia',
  'pakistan': 'South Asia',
  'africa': 'Sub-Saharan Africa',
  'sahel': 'Sub-Saharan Africa',
  'sudan': 'Sub-Saharan Africa',
  'ethiopia': 'Sub-Saharan Africa',
  'somalia': 'Sub-Saharan Africa',
  'latin america': 'Latin America',
  'venezuela': 'Latin America',
  'colombia': 'Latin America',
  'north america': 'North America',
  'europe': 'Western Europe',
  'balkans': 'Western Europe',
  'arctic': 'Arctic',
  'global': 'Global',
  'global markets': 'Global Markets',
};

function normalizeTheater(raw) {
  if (!raw) return 'Global';
  const lower = String(raw).toLowerCase();
  for (const [key, theater] of Object.entries(REGION_THEATER_MAP)) {
    if (lower.includes(key)) return theater;
  }
  // Title-case the raw value as fallback
  return String(raw).trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Global';
}

// ── Signal category mapping for composite detection ────────────────────────────
const TYPE_CATEGORY = {
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 'kinetic',
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: 'electronic_warfare',
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 'military',
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 'civil',
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 'kinetic',
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: 'financial',
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: 'economic',
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: 'cyber',
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 'maritime',
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 'diplomatic',
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 'radiological',
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 'infrastructure',
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE: 'humanitarian',
  CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION: 'intelligence',
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: 'financial',
  CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION: 'information',
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: 'intelligence',
  CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION: 'policy',
};

// Base severity weights for each signal type
// Base severity weights per signal type. These are multiplied by a domain-
// specific factor (e.g. anomaly score, % change) to produce severityScore.
// Scoring thresholds: >=3.5 → CRITICAL, >=2.5 → HIGH, >=1.5 → MEDIUM, else LOW.
// Higher weight = a weaker domain signal can still reach HIGH/CRITICAL.
// Composite escalation starts at 4.0 and grows with categoryMap.size.
const BASE_WEIGHT = {
  CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION: 4.0,  // synthetic — grows with co-firing count
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 3.0,          // high kinetic significance
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 3.0,  // high kinetic significance
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 3.5,     // active alert = direct threat
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 3.5,      // catastrophic potential
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: 2.5,            // active EW operation
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 2.5,           // civil instability
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: 2.5,       // active APT operation
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: 2.5, // immediate humanitarian
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: 2.5,       // composite CII deterioration
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: 2.0,              // financial stress indicator
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: 2.0,        // supply shock proxy
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 2.0,    // logistics/trade impact
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 2.0,  // operational disruption
  CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE: 2.0,     // humanitarian — lagging
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: 2.0,          // broad market indicator
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 1.5,        // policy action — slow burn
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: 1.5,    // environmental — regional
  CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION: 1.5, // predictive — lower confidence
  CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME: 1.5,        // environmental — regional
  CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION: 1.5, // sentiment — lagging
  CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION: 2.0,      // policy action — direct market impact
};

function scoreTier(score) {
  if (score >= 3.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL';
  if (score >= 2.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH';
  if (score >= 1.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM';
  return 'CROSS_SOURCE_SIGNAL_SEVERITY_LOW';
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Read all source keys in parallel via Upstash pipeline ─────────────────────
async function readAllSourceKeys() {
  const commands = SOURCE_KEYS.map(k => ['GET', k]);
  const results = await cfPipeline(commands);
  const data = {};
  for (let i = 0; i < SOURCE_KEYS.length; i++) {
    const raw = results[i]?.result;
    if (!raw) continue;
    try { data[SOURCE_KEYS[i]] = JSON.parse(raw); } catch { /* skip malformed */ }
  }
  return data;
}