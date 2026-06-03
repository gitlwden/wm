import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';
import { unwrapEnvelope } from './_seed-envelope.js';

export const config = { runtime: 'edge' };

const BOOTSTRAP_CACHE_KEYS = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  ddosAttacks:      'cf:radar:ddos:v1',
  trafficAnomalies: 'cf:radar:traffic-anomalies:v1',
  marketQuotes:     'market:stocks-bootstrap:v1',
  commodityQuotes:  'market:commodities-bootstrap:v1',
  sectors:          'market:sectors:v2',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  bisDsr:           'economic:bis:dsr:v1',
  bisPropertyResidential: 'economic:bis:property-residential:v1',
  bisPropertyCommercial:  'economic:bis:property-commercial:v1',
  imfMacro:         'economic:imf:macro:v2',
  imfGrowth:        'economic:imf:growth:v1',
  imfLabor:         'economic:imf:labor:v1',
  imfExternal:      'economic:imf:external:v1',
  // plan 2026-04-25-004 Phase 2 (financialSystemExposure data keys):
  // intentionally NOT added here. The 3 new keys
  // (economic:wb-external-debt:v1, economic:bis-lbs:v1,
  //  economic:fatf-listing:v1) are SERVER-ONLY inputs to
  // scoreFinancialSystemExposure — no client-side panel consumes them
  // directly. AGENTS.md's "new data sources must hydrate via bootstrap"
  // applies to keys with `getHydratedData` consumers in src/; the
  // bootstrap-key-hydration-coverage test enforces that invariant. If
  // a future PR adds a client panel that displays raw BIS LBS / FATF /
  // WB external-debt data, register the keys here AND add the
  // corresponding consumer + cache-keys.ts entries in the same PR.
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v4',
  minerals:         'supply_chain:minerals:v2',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v2',
  climateDisasters: 'climate:disasters:v1',
  co2Monitoring: 'climate:co2-monitoring:v1',
  oceanIce: 'climate:ocean-ice:v1',
  climateNews:      'climate:news-intelligence:v1',
  radiationWatch: 'radiation:observations:v1',
  thermalEscalation: 'thermal:escalation:v1',
  crossSourceSignals: 'intelligence:cross-source-signals:v1',
  wildfires:        'wildfire:fires:v1',
  cyberThreats:     'cyber:threats-bootstrap:v2',
  techReadiness:    'economic:worldbank-techreadiness:v1',
  progressData:     'economic:worldbank-progress:v1',
  renewableEnergy:  'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  theaterPosture: 'theater_posture:sebuf:stale:v1',
  riskScores: 'risk:scores:sebuf:stale:v3',
  naturalEvents: 'natural:events:v1',
  flightDelays: 'aviation:delays-bootstrap:v2',
  insights: 'news:insights:v1',
  predictions: 'prediction:markets-bootstrap:v1',
  cryptoQuotes:     'market:crypto:v1',
  cryptoSectors:    'market:crypto-sectors:v1',
  defiTokens:       'market:defi-tokens:v1',
  aiTokens:         'market:ai-tokens:v1',
  otherTokens:      'market:other-tokens:v1',
  gulfQuotes:       'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents: 'unrest:events:v1',
  iranEvents: 'conflict:iran-events:v1',
  ucdpEvents: 'conflict:ucdp-events:v1',
  temporalAnomalies: 'temporal:anomalies:v1',
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
  techEvents:        'research:tech-events:v1',
  gdeltIntel:        'intelligence:gdelt-intel:v1',
  correlationCards:   'correlation:cards-bootstrap:v1',
  forecasts:         'forecast:predictions:v2',
  securityAdvisories: 'intelligence:advisories-bootstrap:v1',
  customsRevenue:    'trade:customs-revenue:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  consumerPricesOverview:   'consumer-prices:overview:ae',
  consumerPricesCategories: 'consumer-prices:categories:ae:30d',
  consumerPricesMovers:     'consumer-prices:movers:ae:30d',
  consumerPricesSpread:     'consumer-prices:retailer-spread:ae:essentials-ae',
  groceryBasket: 'economic:grocery-basket:v1',
  bigmac:        'economic:bigmac:v1',
  fuelPrices:    'economic:fuel-prices:v1',
  faoFoodPriceIndex: 'economic:fao-ffpi:v1',
  nationalDebt:      'economic:national-debt:v1',
  euGasStorage:      'economic:eu-gas-storage:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  eurostatHousePrices: 'economic:eurostat:house-prices:v1',
  eurostatGovDebtQ:    'economic:eurostat:gov-debt-q:v1',
  eurostatIndProd:     'economic:eurostat:industrial-production:v1',
  marketImplications: 'intelligence:market-implications:v1',
  fearGreedIndex:    'market:fear-greed:v1',
  hyperliquidFlow:   'market:hyperliquid:flow:v1',
  crudeInventories:  'economic:crude-inventories:v1',
  natGasStorage:     'economic:nat-gas-storage:v1',
  ecbFxRates:        'economic:ecb-fx-rates:v1',
  euFsi:             'economic:fsi-eu:v1',
  shippingStress:    'supply_chain:shipping_stress:v1',
  socialVelocity:    'intelligence:social:reddit:v1',
  wsbTickers:        'intelligence:wsb-tickers:v1',
  pizzint:           'intelligence:pizzint:seed:v1',
  diseaseOutbreaks:  'health:disease-outbreaks:v1',
  economicStress:    'economic:stress-index:v1',
 fredVix: 'economic:fred:v1:VIXCLS:0',
 fredHySpread: 'economic:fred:v1:BAMLH0A0HYM2:0',
 fredIcsa: 'economic:fred:v1:ICSA:0',
 fredMortgage: 'economic:fred:v1:MORTGAGE30US:0',
 fredFedFunds: 'economic:fred:v1:FEDFUNDS:0',
 fred10y2y: 'economic:fred:v1:T10Y2Y:0',
 fredM2: 'economic:fred:v1:M2SL:0',
 fredUnrate: 'economic:fred:v1:UNRATE:0',
 fredCpi: 'economic:fred:v1:CPIAUCSL:0',
 fredDgs10: 'economic:fred:v1:DGS10:0',
 fredWalcl: 'economic:fred:v1:WALCL:0',
 fredGdp: 'economic:fred:v1:GDP:0',
  jodiOil:              'energy:jodi-oil:v1:_countries',
  chokepointBaselines:  'energy:chokepoint-baselines:v1',
  portwatchChokepointsRef: 'portwatch:chokepoints:ref:v1',
  portwatchPortActivity: 'supply_chain:portwatch-ports:v1:_countries',
  oilStocksAnalysis:    'energy:oil-stocks-analysis:v1',
  lngVulnerability:     'energy:lng-vulnerability:v1',
  sprPolicies:          'energy:spr-policies:v1',
  pipelinesGas:         'energy:pipelines:gas:v1',
  pipelinesOil:         'energy:pipelines:oil:v1',
  storageFacilities:    'energy:storage-facilities:v1',
  fuelShortages:        'energy:fuel-shortages:v1',
  energyDisruptions:    'energy:disruptions:v1',
  energyCrisisPolicies: 'energy:crisis-policies:v1',
  aaiiSentiment:        'market:aaii-sentiment:v1',
  breadthHistory:       'market:breadth-history:v1',
  earningsCalendar:     'market:earnings-calendar:v1',
  economicCalendar:     'economic:econ-calendar:v1',
  cotPositioning:       'market:cot:v1',
};

const SLOW_KEYS = new Set([
  'bisPolicy', 'bisExchange', 'bisCredit',
  'bisDsr', 'bisPropertyResidential', 'bisPropertyCommercial',
  'imfMacro', 'imfGrowth', 'imfLabor', 'imfExternal', 'minerals', 'giving',
  'sectors', 'etfFlows', 'wildfires', 'climateAnomalies', 'climateDisasters', 'co2Monitoring', 'oceanIce', 'climateNews',
  'radiationWatch', 'thermalEscalation', 'crossSourceSignals',
  'cyberThreats', 'techReadiness', 'progressData', 'renewableEnergy',
  'naturalEvents',
  'cryptoQuotes', 'cryptoSectors', 'defiTokens', 'aiTokens', 'otherTokens',
  'gulfQuotes', 'stablecoinMarkets', 'unrestEvents', 'ucdpEvents',
  'techEvents',
  'securityAdvisories',
  'customsRevenue',
  'sanctionsPressure',
  'consumerPricesOverview', 'consumerPricesCategories', 'consumerPricesMovers', 'consumerPricesSpread',
  'groceryBasket',
  'bigmac',
  'fuelPrices',
  'faoFoodPriceIndex',
  'nationalDebt',
  'euGasStorage',
  'eurostatCountryData',
  'eurostatHousePrices',
  'eurostatGovDebtQ',
  'eurostatIndProd',
  'marketImplications',
  'fearGreedIndex',
  'hyperliquidFlow',
  'crudeInventories',
  'natGasStorage',
  'ecbFxRates',
  'euFsi',
  'diseaseOutbreaks',
  'economicStress',
 'fredVix', 'fredHySpread', 'fredIcsa', 'fredMortgage', 'fredFedFunds',
 'fred10y2y', 'fredM2', 'fredUnrate', 'fredCpi', 'fredDgs10', 'fredWalcl', 'fredGdp',
  'pizzint',
  'electricityPrices',
  'jodiOil',
  'chokepointBaselines',
  'portwatchChokepointsRef',
  'portwatchPortActivity',
  'oilStocksAnalysis',
  'lngVulnerability',
  'sprPolicies',
  'pipelinesGas',
  'pipelinesOil',
  'storageFacilities',
  'fuelShortages',
  'energyDisruptions',
  'energyCrisisPolicies',
  'aaiiSentiment',
  'breadthHistory',
  'earningsCalendar',
  'economicCalendar',
  'cotPositioning',
]);
const FAST_KEYS = new Set([
  'earthquakes', 'outages', 'serviceStatuses', 'ddosAttacks', 'trafficAnomalies', 'macroSignals', 'chokepoints',
  'marketQuotes', 'commodityQuotes', 'positiveGeoEvents', 'riskScores', 'flightDelays','insights', 'predictions',
  'iranEvents', 'temporalAnomalies', 'weatherAlerts', 'spending', 'theaterPosture', 'gdeltIntel',
  'correlationCards', 'forecasts', 'shippingRates', 'shippingStress', 'socialVelocity', 'wsbTickers',
]);

// No public/s-maxage: CF (in front of api.worldmonitor.app) ignores Vary: Origin and would
// pin ACAO: worldmonitor.app on cached responses, breaking CORS for preview deployments.
// Vercel CDN caching is handled by TIER_CDN_CACHE via CDN-Cache-Control below.
const TIER_CACHE = {
  slow: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};

const NEG_SENTINEL = '__WM_NEG__';

// In-process TTL cache — avoids redundant Redis pipeline calls when the same
// edge worker handles multiple bootstrap requests within a short window.
// Each cache entry is keyed by the sorted key set so fast/slow/full tiers
// cache independently.  TTL is short (30 s) to keep data fresh while still
// cutting Redis ops by ~80 % during traffic bursts.
const _bootstrapCache = /** @type {Map<string, {expires: number, data: Map<string, unknown>}>} */ (new Map());
const BOOTSTRAP_INPROC_TTL_MS = 30_000;

function getCachedBootstrapBatch(keys) {
  const cacheKey = keys.join(',');
  const now = Date.now();
  const entry = _bootstrapCache.get(cacheKey);
  if (entry && entry.expires > now) return entry.data;
  return null;
}

function setCachedBootstrapBatch(keys, data) {
  const cacheKey = keys.join(',');
  _bootstrapCache.set(cacheKey, { data, expires: Date.now() + BOOTSTRAP_INPROC_TTL_MS });
  // Bound cache size — delete oldest entries when over 20
  if (_bootstrapCache.size > 20) {
    const firstKey = _bootstrapCache.keys().next().value;
    if (firstKey) _bootstrapCache.delete(firstKey);
  }
}

async function getCachedJsonBatch(keys) {
  const result = new Map();
  if (keys.length === 0) return result;

  // Always read unprefixed keys — bootstrap is a read-only consumer of
  // production cache data. Preview/branch deploys don't run handlers that
  // populate prefixed keys, so prefixing would always miss.
  const pipeline = keys.map((k) => ['GET', k]);
  const data = await redisPipeline(pipeline, 3000);
  if (data) {
    for (let i = 0; i < keys.length; i++) {
      const raw = data[i]?.result;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed === NEG_SENTINEL) continue;
          result.set(keys[i], unwrapEnvelope(parsed).data);
        } catch { /* skip malformed */ }
      }
    }
  }

  // CF KV fallback for keys missing from Upstash.
  // Handles the migration window where data was written to CF KV before the
  // routing inversion (388e96a7) moved writes to Upstash.
  const missing = keys.filter((k) => !result.has(k));
  if (missing.length > 0) {
    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfNamespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    if (cfAccountId && cfNamespaceId && cfToken) {
      const cfBase = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/storage/kv/namespaces/${cfNamespaceId}`;
      const cfHeaders = { Authorization: `Bearer ${cfToken}` };
      const cfReads = missing.map(async (k) => {
        try {
          const resp = await fetch(`${cfBase}/values/${encodeURIComponent(k)}`, {
            headers: cfHeaders,
            signal: AbortSignal.timeout(3000),
          });
          if (!resp.ok) return;
          const text = await resp.text();
          if (!text) return;
          const parsed = JSON.parse(text);
          if (parsed === NEG_SENTINEL) return;
          result.set(k, unwrapEnvelope(parsed).data);
        } catch { /* skip */ }
      });
      await Promise.all(cfReads);
    }
  }

  return result;
}

export default async function handler(req) {
  // if (isDisallowedOrigin(req))
  //   return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  // Development mode: skip API key validation when WM_SESSION_SECRET is not set
  const isDev = !process.env.WM_SESSION_SECRET;
  const apiKeyResult = isDev ? { valid: true, required: false } : await validateApiKey(req);
  // if (apiKeyResult.required && !apiKeyResult.valid)
  //   return jsonResponse({ error: apiKeyResult.error }, 401, cors);

  const url = new URL(req.url);
  const tier = url.searchParams.get('tier');
  let registry;
  if (tier === 'slow' || tier === 'fast') {
    const tierSet = tier === 'slow' ? SLOW_KEYS : FAST_KEYS;
    registry = Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => tierSet.has(k)));
  } else {
    const requested = url.searchParams.get('keys')?.split(',').filter(Boolean).sort();
    registry = requested
      ? Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => requested.includes(k)))
      : BOOTSTRAP_CACHE_KEYS;
  }

  const keys = Object.values(registry);
  const names = Object.keys(registry);

  let cached = getCachedBootstrapBatch(keys);
  if (!cached) {
    try {
      cached = await getCachedJsonBatch(keys);
      setCachedBootstrapBatch(keys, cached);
    } catch {
      return jsonResponse({ data: {}, missing: names }, 200, { ...cors, 'Cache-Control': 'no-cache' });
    }
  }

  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) {
      // Strip seed-internal metadata not intended for API clients
      if (names[i] === 'forecasts' && val != null && 'enrichmentMeta' in val) {
        const { enrichmentMeta: _stripped, ...rest } = val;
        data[names[i]] = rest;
      } else {
        data[names[i]] = val;
      }
    } else {
      missing.push(names[i]);
    }
  }

  const cacheControl = (tier && TIER_CACHE[tier]) || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';

  // The browser runtime sends API requests with credentials so session and
  // entitlement cookies can ride along. Credentialed requests cannot consume
  // ACAO: * responses, even for public bootstrap data.
  return jsonResponse({ data, missing }, 200, {
    ...cors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': (tier && TIER_CDN_CACHE[tier]) || TIER_CDN_CACHE.fast,
  });
}
