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
import { parseStringArray, fetchFinnhubQuote, fetchYahooQuote, YAHOO_ONLY_SYMBOLS, sanitizeSymbol } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

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
    if (missing.length > 0) {
      const finnhubKey = process.env.FINNHUB_API_KEY;
      const liveQuotes = await fetchLiveQuotes(missing, finnhubKey);
      filtered.push(...liveQuotes);
    }

    return { quotes: filtered, finnhubSkipped: false, skipReason: '', rateLimited: false };
  } catch {
    return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
  }
}

/**
 * Fetch live quotes for symbols not in the bootstrap cache.
 * Tries Finnhub for regular stocks, Yahoo for indices/futures/forex.
 */
async function fetchLiveQuotes(
  symbols: string[],
  finnhubKey: string | undefined,
): Promise<MarketQuote[]> {
  const results: MarketQuote[] = [];
  const yahooSymbols: string[] = [];

  for (const raw of symbols) {
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

  // Batch-fetch Yahoo symbols
  for (const sym of yahooSymbols) {
    const yq = await fetchYahooQuote(sym);
    if (yq) {
      results.push({
        symbol: sym,
        name: sym,
        display: sym,
        price: yq.price,
        change: yq.change,
        sparkline: yq.sparkline,
      });
    }
  }

  return results;
}
