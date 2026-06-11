/**
 * RPC: ListCryptoSectors -- reads seeded crypto sector data from Railway seed cache,
 * falls back to live CoinGecko/CoinPaprika API when Redis has no data.
 */

import type {
  ServerContext,
  ListCryptoSectorsRequest,
  ListCryptoSectorsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { fetchCoinGeckoMarkets } from './_shared';
import sectorsConfig from '../../../../shared/crypto-sectors.json';

const SEED_CACHE_KEY = 'market:crypto-sectors:v1';

const SECTORS = sectorsConfig.sectors;

export async function listCryptoSectors(
  _ctx: ServerContext,
  _req: ListCryptoSectorsRequest,
): Promise<ListCryptoSectorsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { sectors: Array<{ id: string; name: string; change: number }> } | null;
    if (seedData?.sectors?.length) return { sectors: seedData.sectors };
  } catch {
    // Redis miss — fall through to live fetch
  }

  // Live fallback: fetch all sector tokens from CoinGecko, compute per-sector averages
  try {
    const allIds = [...new Set(SECTORS.flatMap(s => s.tokens))];
    const data = await fetchCoinGeckoMarkets(allIds);
    const byId = new Map(data.map(c => [c.id, c.price_change_percentage_24h]));

    const sectors = SECTORS.map(sector => {
      const changes = sector.tokens
        .map(id => byId.get(id))
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const change = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      return { id: sector.id, name: sector.name, change };
    });
    return { sectors };
  } catch (err) {
    console.warn('[listCryptoSectors] Live fetch failed, trying CoinPaprika:', (err as Error).message);

    // CoinPaprika doesn't map to all sector tokens, but we can try best-effort
    try {
      const { fetchCoinPaprikaMarkets } = await import('./_shared');
      const allIds = [...new Set(SECTORS.flatMap(s => s.tokens))];
      const data = await fetchCoinPaprikaMarkets(allIds);
      const byId = new Map(data.map(c => [c.id, c.price_change_percentage_24h]));

      const sectors = SECTORS.map(sector => {
        const changes = sector.tokens
          .map(id => byId.get(id))
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const change = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
        return { id: sector.id, name: sector.name, change };
      });
      return { sectors };
    } catch (err2) {
      console.warn('[listCryptoSectors] CoinPaprika fallback also failed:', (err2 as Error).message);
      return { sectors: [] };
    }
  }
}
