/**
 * RPC: listBigMacPrices -- reads seeded Big Mac Index data from Upstash Redis.
 * Primary: Redis cache (populated by seed-bigmac.mjs via GitHub Actions).
 * Fallback: Economist GitHub CSV (when Redis has no data).
 */

import type {
  ServerContext,
  ListBigMacPricesRequest,
  ListBigMacPricesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:bigmac:v1';

const ECONOMIST_CSV_URLS = [
  'https://raw.githubusercontent.com/TheEconomist/big-mac-data/refs/heads/main/output-data/big-mac-full-index.csv',
  'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/output-data/big-mac-full-index.csv',
];

/** ISO A3 → A2 mapping for Economist CSV data */
const A3_TO_A2: Record<string, string> = {
  ARE: 'AE', ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BRA: 'BR',
  GBR: 'GB', CAN: 'CA', CHL: 'CL', CHN: 'CN', COL: 'CO', CRI: 'CR',
  CZE: 'CZ', DNK: 'DK', EGY: 'EG', EST: 'EE', FIN: 'FI', FRA: 'FR',
  DEU: 'DE', GRC: 'GR', HKG: 'HK', HUN: 'HU', IND: 'IN', IDN: 'ID',
  IRL: 'IE', ISR: 'IL', ITA: 'IT', JPN: 'JP', KOR: 'KR', KWT: 'KW',
  LVA: 'LV', LTU: 'LT', LUX: 'LU', MYS: 'MY', MEX: 'MX', NLD: 'NL',
  NZL: 'NZ', NOR: 'NO', PAK: 'PK', PER: 'PE', PHL: 'PH', POL: 'PL',
  PRT: 'PT', QAT: 'QA', ROU: 'RO', RUS: 'RU', SAU: 'SA', SGP: 'SG',
  ZAF: 'ZA', ESP: 'ES', SWE: 'SE', CHE: 'CH', TWN: 'TW', THA: 'TH',
  TUR: 'TR', UKR: 'UA', UAE: 'AE', USA: 'US', VEN: 'VE', VNM: 'VN',
  LBN: 'LB', JOR: 'JO', BHR: 'BH', OMN: 'OM', KEN: 'KE', NGA: 'NG',
  PRY: 'PY', URY: 'UY', LKA: 'LK', BGD: 'BD', AZE: 'AZ', GEO: 'GE',
  SRB: 'RS', CYP: 'CY', SVK: 'SK', SVN: 'SI',
};

const EMPTY_RESPONSE: ListBigMacPricesResponse = {
  countries: [],
  fetchedAt: '',
  cheapestCountry: '',
  mostExpensiveCountry: '',
  wowAvgPct: 0,
  wowAvailable: false,
  prevFetchedAt: '',
};

/**
 * Fetch and parse the Economist Big Mac Index CSV as a fallback.
 * Tries both `main` and `master` branches.
 * Returns the same shape as the seeded Redis data.
 */
async function fetchEconomistCsvFallback(): Promise<ListBigMacPricesResponse> {
  let text: string | undefined;

  for (const url of ECONOMIST_CSV_URLS) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'WorldMonitor/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) continue;
      text = await resp.text();
      if (text.length > 100) break;
      text = undefined;
    } catch {
      // try next URL
    }
  }

  if (!text) throw new Error('All Economist CSV URLs failed');

  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('Empty CSV');

  const header = lines[0].split(',');
  const dateIdx = header.indexOf('date');
  const a3Idx = header.indexOf('iso_a3');
  const ccyIdx = header.indexOf('currency_code');
  const nameIdx = header.indexOf('name');
  const localIdx = header.indexOf('local_price');
  const exIdx = header.indexOf('dollar_ex');
  const usdIdx = header.indexOf('dollar_price');

  if ([dateIdx, a3Idx, localIdx, usdIdx].some(i => i < 0)) {
    throw new Error('CSV missing required columns');
  }

  // Find latest date
  const allDates = [...new Set(lines.slice(1).map(l => l.split(',')[dateIdx]).filter(Boolean))];
  const latestDate = allDates.sort().at(-1)!;
  const rows = lines.slice(1).filter(l => l.startsWith(latestDate));

  const countries: ListBigMacPricesResponse['countries'] = [];
  for (const row of rows) {
    const cols = row.split(',');
    const a3 = cols[a3Idx]?.trim();
    const localPrice = parseFloat(cols[localIdx]);
    const dollarEx = parseFloat(cols[exIdx] ?? '');
    const dollarPrice = parseFloat(cols[usdIdx]);

    if (!a3 || Number.isNaN(localPrice) || Number.isNaN(dollarPrice) || dollarPrice <= 0) continue;

    const a2 = A3_TO_A2[a3] || a3;
    countries.push({
      code: a2,
      name: cols[nameIdx]?.trim() || a3,
      currency: cols[ccyIdx]?.trim() || '',
      flag: '',
      localPrice: +localPrice.toFixed(4),
      usdPrice: +dollarPrice.toFixed(4),
      fxRate: Number.isNaN(dollarEx) ? 0 : +dollarEx.toFixed(6),
      sourceSite: 'economist-github',
      available: true,
      wowPct: 0,
    });
  }

  if (!countries.length) throw new Error('No valid rows in CSV');

  const withData = countries.filter(c => c.usdPrice != null);
  const cheapest = withData.length
    ? withData.reduce((a, b) => (a.usdPrice ?? 0) < (b.usdPrice ?? 0) ? a : b).code!
    : '';
  const mostExpensive = withData.length
    ? withData.reduce((a, b) => (a.usdPrice ?? 0) > (b.usdPrice ?? 0) ? a : b).code!
    : '';

  return {
    countries,
    fetchedAt: latestDate,
    cheapestCountry: cheapest,
    mostExpensiveCountry: mostExpensive,
    wowAvgPct: 0,
    wowAvailable: false,
    prevFetchedAt: '',
  };
}

export async function listBigMacPrices(
  _ctx: ServerContext,
  _req: ListBigMacPricesRequest,
): Promise<ListBigMacPricesResponse> {
  // ── Tier 1: Redis seed cache ──
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListBigMacPricesResponse | null;
    if (result?.countries?.length) {
      return result;
    }
  } catch {
    // Redis unavailable — fall through
  }

  // ── Tier 2: Economist GitHub CSV fallback ──
  try {
    const csvResult = await fetchEconomistCsvFallback();
    if (csvResult.countries?.length) {
      return csvResult;
    }
  } catch (err) {
    console.error('[listBigMacPrices] Economist CSV fallback failed:', err);
  }

  return EMPTY_RESPONSE;
}
