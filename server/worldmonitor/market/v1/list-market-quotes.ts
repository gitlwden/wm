/**
 * RPC: ListMarketQuotes -- reads seeded stock/index data from Railway seed cache.
 * Custom watchlist symbols not in the bootstrap are fetched live from Finnhub/Yahoo.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray, fetchFinnhubQuote, fetchYahooQuote, fetchYahooQuotesBatch, YAHOO_ONLY_SYMBOLS, sanitizeSymbol } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

/** Global timeout for live fetches — prevents Vercel execution time limit kills. */
const LIVE_FETCH_BUDGET_MS = 8_000;

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const parsedSymbols = parseStringArray(req.symbols);

  try {
    const bootstrap = await getCachedJson(BOOTSTRAP_KEY, true) as ListMarketQuotesResponse | null;
    const bootstrapQuotes = bootstrap?.quotes ?? [];

    if (parsedSymbols.length === 0) {
      return bootstrapQuotes.length
        ? { quotes: bootstrapQuotes, finnhubSkipped: false, skipReason: '', rateLimited: false }
        : { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
    }

    // Filter bootstrap for requested symbols
    const bootstrapMap = new Map(bootstrapQuotes.map((q: MarketQuote) => [q.symbol, q]));
    const filtered: MarketQuote[] = [];
    const missing: string[] = [];

    for (const sym of parsedSymbols) {
      const hit = bootstrapMap.get(sym);
      if (hit) {
        filtered.push(hit);
      } else {
        missing.push(sym);
      }
    }

    // Fetch live data for symbols not in bootstrap (custom watchlist entries)
    // Also fires when Redis is down (bootstrap empty → all symbols are "missing")
    let rateLimited = false;
    if (missing.length > 0) {
      const finnhubKey = process.env.FINNHUB_API_KEY;
      const liveResult = await fetchLiveQuotes(missing, finnhubKey);
      filtered.push(...liveResult.quotes);
      rateLimited = liveResult.rateLimited;
    }

    return { quotes: filtered, finnhubSkipped: false, skipReason: '', rateLimited };
  } catch {
    return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
  }
}

/**
 * Fetch live quotes for symbols not in the bootstrap cache.
 * Tries Finnhub for regular stocks, Yahoo for indices/futures/forex.
 * Returns quotes + rateLimited flag when Yahoo returns mostly failures.
 */
async function fetchLiveQuotes(
  symbols: string[],
  finnhubKey: string | undefined,
): Promise<{ quotes: MarketQuote[]; rateLimited: boolean }> {
  const results: MarketQuote[] = [];
  const yahooSymbols: string[] = [];
  const deadline = Date.now() + LIVE_FETCH_BUDGET_MS;

  for (const raw of symbols) {
    if (Date.now() > deadline) break;
    const symbol = sanitizeSymbol(raw);
    if (!symbol) continue;

    if (YAHOO_ONLY_SYMBOLS.has(symbol)) {
      yahooSymbols.push(symbol);
      continue;
    }

    // Try Finnhub first (if key available), fall back to Yahoo
    if (finnhubKey) {
      const fq = await fetchFinnhubQuote(symbol, finnhubKey);
      if (fq) {
        results.push({
          symbol: fq.symbol,
          name: symbol,
          display: symbol,
          price: fq.price,
          change: fq.changePercent,
          sparkline: [],
        });
        continue;
      }
    }

    // Fallback to Yahoo
    yahooSymbols.push(symbol);
  }

  if (yahooSymbols.length === 0) return { quotes: results, rateLimited: false };

  // Batch-fetch Yahoo symbols (has consecutive-fails break built in)
  const batch = await fetchYahooQuotesBatch(yahooSymbols);
  for (const [sym, q] of batch.results) {
    results.push({
      symbol: sym,
      name: sym,
      display: sym,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline,
    });
  }

  // If batch flagged rate-limited OR fewer than half the Yahoo symbols resolved, flag it
  const yahooHitRate = yahooSymbols.length > 0 ? batch.results.size / yahooSymbols.length : 1;
  const rateLimited = batch.rateLimited || yahooHitRate < 0.5;

  return { quotes: results, rateLimited };
}
