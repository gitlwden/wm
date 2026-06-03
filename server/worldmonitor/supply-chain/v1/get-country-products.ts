import type {
  ServerContext,
  GetCountryProductsRequest,
  GetCountryProductsResponse,
  CountryProduct,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { lazyFetchBilateralHs4 } from './_bilateral-hs4-lazy';

interface BilateralHs4Payload {
  iso2: string;
  products?: CountryProduct[];
  fetchedAt?: string;
}

export async function getCountryProducts(
  _ctx: ServerContext,
  req: GetCountryProductsRequest,
): Promise<GetCountryProductsResponse> {
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }

  const empty: GetCountryProductsResponse = { iso2, products: [], fetchedAt: '' };

  // Seeder writes via raw key (no env-prefix) — match it on read.
  const key = `comtrade:bilateral-hs4:${iso2}:v1`;
  let payload = await getCachedJson(key, true).catch(() => null) as BilateralHs4Payload | null;

  // Lazy fallback: if the seed hasn't written this country's key (TTL expired,
  // country not in seed set, or transient Comtrade failure), attempt a live
  // fetch from the UN Comtrade public API.
  if (!payload) {
    const lazy = await lazyFetchBilateralHs4(iso2).catch(() => null);
    if (lazy && lazy.products.length > 0) {
      return { iso2, products: lazy.products as unknown as CountryProduct[], fetchedAt: new Date().toISOString() };
    }
    return empty;
  }

  return {
    iso2,
    products: Array.isArray(payload.products) ? payload.products : [],
    fetchedAt: payload.fetchedAt ?? '',
  };
}
