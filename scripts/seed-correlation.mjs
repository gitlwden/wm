#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials, loadSharedConfig } from './_seed-utils.mjs';
import { resolveIso2, normalizeCountryToken } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'correlation:cards-bootstrap:v1';
const CACHE_TTL = 25200; // 7h — covers the 6h workflow interval with buffer

const INPUT_KEYS = [
  'military:flights:v1',
  'military:flights:stale:v1',
  'unrest:events:v1',
  'infra:outages:v1',
  'seismology:earthquakes:v1',
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'market:crypto:v1',
  'news:insights:v1',
];

async function fetchInputData() {
  return cfPipeline(commands);
}