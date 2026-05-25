/**
 * Trimmed analyst-context variant for brief whyMatters enrichment.
 *
 * `assembleAnalystContext` in chat-analyst-context.ts does 20+ parallel
 * Redis GETs + GDELT (2.5s) + digest-search — overkill for a single-
 * sentence editorial summary. This variant:
 *   - Drops GDELT and digest-keyword-search entirely.
 *   - Drops energy spine (productSupply/gasFlows/oilStocksCover/electricityMix).
 *   - Drops prediction markets, market implications, SPR, refinery utilization.
 *   - Keeps the 6 core bundles the prompt actually uses:
 *       worldBrief, countryBrief (when iso2 provided), riskScores,
 *       forecasts, marketData, macroSignals.
 *
 * Reuses the builders already exported from chat-analyst-context.ts to
 * avoid output-format drift between the analyst chat and this flow.
 * `getCachedJson(key, true)` is the same cache-layer Redis adapter.
 */

import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';

import {
  buildWorldBrief,
  buildRiskScores,
  buildForecasts,
  buildMarketData,
  buildMacroSignals,
  buildCountryBrief,
} from './chat-analyst-context';

export interface BriefStoryContext {
  worldBrief: string;
  countryBrief: string;
  riskScores: string;
  forecasts: string;
  marketData: string;
  macroSignals: string;
  degraded: boolean;
}

interface AssembleArgs {
  iso2: string | null;
  // category is currently unused in context assembly (prompt builder
  // includes it as a story field) but accepted for future per-category
  // gating (e.g. skip market data for humanitarian categories).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  category?: string;
}

/**
 * Parallel-fetch the 6 context bundles the brief whyMatters prompt
 * needs. All failures are swallowed by Promise.allSettled — the
 * function never throws. `degraded` is flipped when more than 2
 * core bundles failed, so the prompt builder can degrade output
 * accordingly.
 */
export async function assembleBriefStoryContext(
  args: AssembleArgs,
): Promise<BriefStoryContext> {
  const iso2 = args.iso2;
  const countryKey = iso2 ? `intelligence:country-brief:v1:${iso2}` : null;

  const FIXED_KEYS = ['news:insights:v1', 'risk:scores:sebuf:stale:v1', 'forecast:predictions:v2', 'market:stocks-bootstrap:v1', 'market:commodities-bootstrap:v1', 'economic:macro-signals:v1'] as const;
  const [briefBatch, countryRaw] = await Promise.all([
    getCachedJsonBatch([...FIXED_KEYS], true),
    countryKey ? getCachedJson(countryKey, true) : Promise.resolve(null),
  ]);

  const insightsResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[0]) ?? null };
  const riskResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[1]) ?? null };
  const forecastsResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[2]) ?? null };
  const stocksResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[3]) ?? null };
  const commoditiesResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[4]) ?? null };
  const macroResult = { status: 'fulfilled' as const, value: briefBatch.get(FIXED_KEYS[5]) ?? null };
  const countryResult = { status: 'fulfilled' as const, value: countryRaw };

  const get = (r: PromiseSettledResult<unknown>): unknown =>
    r.status === 'fulfilled' ? r.value : null;

  // Count only the core (non-country-specific) sources for the degraded
  // flag — missing countryBrief is expected whenever iso2 is null.
  const coreResults = [
    insightsResult,
    riskResult,
    forecastsResult,
    stocksResult,
    commoditiesResult,
    macroResult,
  ];
  const failCount = coreResults.filter(
    (r) => r.status === 'rejected' || r.value === null || r.value === undefined,
  ).length;

  return {
    worldBrief: buildWorldBrief(get(insightsResult)),
    countryBrief: buildCountryBrief(get(countryResult)),
    riskScores: buildRiskScores(get(riskResult)),
    forecasts: buildForecasts(get(forecastsResult)),
    marketData: buildMarketData(get(stocksResult), get(commoditiesResult)),
    macroSignals: buildMacroSignals(get(macroResult)),
    degraded: failCount > 2,
  };
}
