/**
 * RPC: GetSectorSummary -- reads seeded sector data from Railway seed cache.
 * All external Finnhub/Yahoo Finance calls happen in ais-relay.cjs on Railway.
 *
 * Self-healing: when Redis seed is empty (Railway cron expired / never ran),
 * this handler fetches sector ETF data directly from Yahoo Finance, caches it
 * in Redis, and returns it. Subsequent requests hit the Redis cache.
 */

import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
  SectorPerformance,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { buildEnvelope } from '../../../_shared/seed-envelope';

const SEED_CACHE_KEY = 'market:sectors:v2';
const FALLBACK_TTL = 7200; // 2h — matches MARKET_SEED_TTL in ais-relay.cjs

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'] as const;

const SECTOR_NAMES: Record<string, string> = {
  XLK: 'Technology',
  XLF: 'Financials',
  XLE: 'Energy',
  XLV: 'Health Care',
  XLY: 'Consumer Disc.',
  XLI: 'Industrials',
  XLP: 'Con. Staples',
  XLU: 'Utilities',
  XLB: 'Materials',
  XLRE: 'Real Estate',
  XLC: 'Comm. Svcs',
  SMH: 'Semiconductors',
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Fetch a single sector ETF's daily change from Yahoo Finance chart API.
 * Mirrors _fetchYahooChartNoProxy in scripts/ais-relay.cjs.
 */
async function fetchSectorFromYahoo(symbol: string): Promise<SectorPerformance | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    const chart = data?.chart as Record<string, unknown> | undefined;
    const result = (chart?.result as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const meta = result?.meta as Record<string, unknown> | undefined;
    if (!meta) return null;
    const price = meta.regularMarketPrice as number | undefined;
    const prevClose = (meta.chartPreviousClose ?? meta.previousClose ?? price) as number | undefined;
    if (!price || !prevClose) return null;
    const change = ((price - prevClose) / prevClose) * 100;
    return {
      symbol,
      name: SECTOR_NAMES[symbol] ?? symbol,
      change: Math.round(change * 100) / 100,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch all 12 sector ETFs from Yahoo Finance with conservative pacing.
 * Returns null if every fetch fails (upstream outage).
 */
async function fetchSectorsFromYahoo(): Promise<GetSectorSummaryResponse | null> {
  const sectors: SectorPerformance[] = [];
  for (const symbol of SECTOR_SYMBOLS) {
    const sector = await fetchSectorFromYahoo(symbol);
    if (sector) sectors.push(sector);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (sectors.length === 0) return null;
  return { sectors };
}

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  // 1. Try the seeded Redis cache first
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as GetSectorSummaryResponse | null;
    if (cached?.sectors?.length) return cached;
  } catch {
    /* cache read error — fall through to live fetch */
  }

  // 2. Self-heal: fetch directly from Yahoo Finance when seed data is missing
  try {
    const fallback = await fetchSectorsFromYahoo();
    if (fallback?.sectors?.length) {
      // Write back to Redis so subsequent requests (and bootstrap hydration) are fast
      const envelope = buildEnvelope({
        fetchedAt: Date.now(),
        recordCount: fallback.sectors.length,
        sourceVersion: 'market-sectors-fallback',
        schemaVersion: 1,
        state: 'OK',
        data: fallback,
      });
      // Fire-and-forget write — don't block the response
      void setCachedJson(SEED_CACHE_KEY, envelope, FALLBACK_TTL, true).catch(() => {});
      return fallback;
    }
  } catch {
    /* fallback fetch error — return empty */
  }

  return { sectors: [] };
}
