/**
 * RPC: ListCryptoQuotes -- reads seeded crypto data from Railway seed cache,
 * falls back to live CoinPaprika/CoinGecko API when Redis has no data.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CRYPTO_META, parseStringArray, fetchCryptoMarkets } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:crypto:v1';

const SYMBOL_TO_ID = new Map(Object.entries(CRYPTO_META).map(([id, m]) => [m.symbol, id]));

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const parsedIds = parseStringArray(req.ids);
  const ids = parsedIds.length > 0 ? parsedIds : Object.keys(CRYPTO_META);

  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { quotes: CryptoQuote[] } | null;
    if (seedData?.quotes?.length) {
      const allIds = new Set(ids);
      const filtered = allIds.size === 0
        ? seedData.quotes
        : seedData.quotes.filter((q) => allIds.has(SYMBOL_TO_ID.get(q.symbol) ?? ''));
      return { quotes: filtered };
    }
  } catch {
    // Redis miss — fall through to live fetch
  }

  // Live fallback: CoinPaprika (primary) → CoinGecko
  try {
    const markets = await fetchCryptoMarkets(ids);
    const byId = new Map(markets.map(c => [c.id, c]));
    const quotes: CryptoQuote[] = [];
    for (const id of ids) {
      const coin = byId.get(id);
      if (!coin) continue;
      const meta = CRYPTO_META[id];
      const prices = coin.sparkline_in_7d?.price;
      const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);
      quotes.push({
        name: meta?.name || coin.name || id,
        symbol: meta?.symbol || (coin.symbol?.toUpperCase() ?? id),
        price: coin.current_price ?? 0,
        change: coin.price_change_percentage_24h ?? 0,
        sparkline,
        change7d: coin.price_change_percentage_7d_in_currency ?? 0,
      });
    }
    return { quotes };
  } catch (err) {
    console.warn('[listCryptoQuotes] Live fetch failed:', (err as Error).message);
    return { quotes: [] };
  }
}
