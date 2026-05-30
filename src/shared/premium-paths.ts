/**
 * Premium RPC paths that require either an API key or a Pro session.
 *
 * Consumed by the server gateway for auth enforcement (needsLegacyProBearerGate).
 * Adding a path here means the gateway rejects anonymous wms_ tokens and
 * requires a real API key or Clerk Pro session.
 */
export const PREMIUM_RPC_PATHS = new Set<string>([
  '/api/latest-brief',
  '/api/bootstrap',
  '/api/market/v1/analyze-stock',
  '/api/market/v1/get-stock-analysis-history',
  '/api/market/v1/backtest-stock',
  '/api/market/v1/get-insider-transactions',
  '/api/market/v1/list-stored-stock-backtests',
   '/api/intelligence/v1/list-market-implications',
  '/api/intelligence/v1/get-regional-snapshot',
  '/api/intelligence/v1/get-regime-history',
  '/api/intelligence/v1/get-regional-brief',
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/supply-chain/v1/get-country-chokepoint-index',
  '/api/supply-chain/v1/get-bypass-options',
  '/api/supply-chain/v1/get-country-cost-shock',
  '/api/supply-chain/v1/get-route-explorer-lane',
  '/api/supply-chain/v1/get-route-impact',
  '/api/supply-chain/v1/get-country-products',
  '/api/supply-chain/v1/get-multi-sector-cost-shock',
  '/api/supply-chain/v1/get-sector-dependency',
  '/api/economic/v1/get-national-debt',
  '/api/trade/v1/list-comtrade-flows',
  '/api/trade/v1/get-tariff-trends',
  '/api/scenario/v1/run-scenario',
  '/api/scenario/v1/get-scenario-status',
  '/api/v2/shipping/route-intelligence',
  '/api/v2/shipping/webhooks',
]);

/**
 * Paths where the client should inject premium auth (Clerk Bearer, tester key,
 * or WORLDMONITOR_API_KEY) even if the gateway does not enforce it.
 *
 * Superset of PREMIUM_RPC_PATHS. Unlike PREMIUM_RPC_PATHS, adding a path here
 * does NOT cause the gateway to reject anonymous wms_ tokens — it only affects
 * client-side auth injection in premiumFetch and enrichInitForPremium.
 *
 * Use this for endpoints that benefit from caller identity (e.g. to honour a
 * framework/systemAppend parameter) but should still work for anonymous users.
 */
export const PREMIUM_FETCH_PATHS = new Set<string>([
  ...PREMIUM_RPC_PATHS,
  '/api/intelligence/v1/deduct-situation',
]);