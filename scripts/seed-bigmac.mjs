#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep, readSeedSnapshot, getSharedFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:bigmac:v1';
const CACHE_TTL = 864000; // 10 days — weekly seed with 3-day cron-drift buffer
const EXA_DELAY_MS = 150;

const FX_FALLBACKS = SHARED_FX_FALLBACKS;

// WoW validation thresholds
const MIN_WOW_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days minimum between snapshots
const WOW_ANOMALY_THRESHOLD = 20; // % change that signals a data bug

// USD price sanity range for a Big Mac globally
const USD_MIN = 1.50;
const USD_MAX = 12.00;

// ISO A3 -> A2 mapping for Economist CSV data
const A3_TO_A2 = {
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

// ISO A2 -> country metadata (flag, name, currency)
const COUNTRY_META = {
  US: { name: 'United States', currency: 'USD', flag: '🇺🇸' },
  CA: { name: 'Canada', currency: 'CAD', flag: '🇨🇦' },
  MX: { name: 'Mexico', currency: 'MXN', flag: '🇲🇽' },
  BR: { name: 'Brazil', currency: 'BRL', flag: '🇧🇷' },
  AR: { name: 'Argentina', currency: 'ARS', flag: '🇦🇷' },
  CO: { name: 'Colombia', currency: 'COP', flag: '🇨🇴' },
  CL: { name: 'Chile', currency: 'CLP', flag: '🇨🇱' },
  GB: { name: 'UK', currency: 'GBP', flag: '🇬🇧' },
  DE: { name: 'Germany', currency: 'EUR', flag: '🇩🇪' },
  FR: { name: 'France', currency: 'EUR', flag: '🇫🇷' },
  IT: { name: 'Italy', currency: 'EUR', flag: '🇮🇹' },
  ES: { name: 'Spain', currency: 'EUR', flag: '🇪🇸' },
  CH: { name: 'Switzerland', currency: 'CHF', flag: '🇨🇭' },
  NO: { name: 'Norway', currency: 'NOK', flag: '🇳🇴' },
  SE: { name: 'Sweden', currency: 'SEK', flag: '🇸🇪' },
  DK: { name: 'Denmark', currency: 'DKK', flag: '🇩🇰' },
  PL: { name: 'Poland', currency: 'PLN', flag: '🇵🇱' },
  CZ: { name: 'Czechia', currency: 'CZK', flag: '🇨🇿' },
  HU: { name: 'Hungary', currency: 'HUF', flag: '🇭🇺' },
  RO: { name: 'Romania', currency: 'RON', flag: '🇷🇴' },
  UA: { name: 'Ukraine', currency: 'UAH', flag: '🇺🇦' },
  CN: { name: 'China', currency: 'CNY', flag: '🇨🇳' },
  JP: { name: 'Japan', currency: 'JPY', flag: '🇯🇵' },
  KR: { name: 'South Korea', currency: 'KRW', flag: '🇰🇷' },
  AU: { name: 'Australia', currency: 'AUD', flag: '🇦🇺' },
  NZ: { name: 'New Zealand', currency: 'NZD', flag: '🇳🇿' },
  SG: { name: 'Singapore', currency: 'SGD', flag: '🇸🇬' },
  HK: { name: 'Hong Kong', currency: 'HKD', flag: '🇭🇰' },
  TW: { name: 'Taiwan', currency: 'TWD', flag: '🇹🇼' },
  TH: { name: 'Thailand', currency: 'THB', flag: '🇹🇭' },
  MY: { name: 'Malaysia', currency: 'MYR', flag: '🇲🇾' },
  ID: { name: 'Indonesia', currency: 'IDR', flag: '🇮🇩' },
  PH: { name: 'Philippines', currency: 'PHP', flag: '🇵🇭' },
  VN: { name: 'Vietnam', currency: 'VND', flag: '🇻🇳' },
  IN: { name: 'India', currency: 'INR', flag: '🇮🇳' },
  PK: { name: 'Pakistan', currency: 'PKR', flag: '🇵🇰' },
  AE: { name: 'UAE', currency: 'AED', flag: '🇦🇪' },
  SA: { name: 'Saudi Arabia', currency: 'SAR', flag: '🇸🇦' },
  QA: { name: 'Qatar', currency: 'QAR', flag: '🇶🇦' },
  KW: { name: 'Kuwait', currency: 'KWD', flag: '🇰🇼' },
  BH: { name: 'Bahrain', currency: 'BHD', flag: '🇧🇭' },
  OM: { name: 'Oman', currency: 'OMR', flag: '🇴🇲' },
  EG: { name: 'Egypt', currency: 'EGP', flag: '🇪🇬' },
  JO: { name: 'Jordan', currency: 'JOD', flag: '🇯🇴' },
  LB: { name: 'Lebanon', currency: 'LBP', flag: '🇱🇧' },
  IL: { name: 'Israel', currency: 'ILS', flag: '🇮🇱' },
  ZA: { name: 'South Africa', currency: 'ZAR', flag: '🇿🇦' },
  NG: { name: 'Nigeria', currency: 'NGN', flag: '🇳🇬' },
  KE: { name: 'Kenya', currency: 'KES', flag: '🇰🇪' },
  RU: { name: 'Russia', currency: 'RUB', flag: '🇷🇺' },
  TR: { name: 'Turkey', currency: 'TRY', flag: '🇹🇷' },
  PE: { name: 'Peru', currency: 'PEN', flag: '🇵🇪' },
  NL: { name: 'Netherlands', currency: 'EUR', flag: '🇳🇱' },
  BE: { name: 'Belgium', currency: 'EUR', flag: '🇧🇪' },
  AT: { name: 'Austria', currency: 'EUR', flag: '🇦🇹' },
  FI: { name: 'Finland', currency: 'EUR', flag: '🇫🇮' },
  GR: { name: 'Greece', currency: 'EUR', flag: '🇬🇷' },
  PT: { name: 'Portugal', currency: 'EUR', flag: '🇵🇹' },
  IE: { name: 'Ireland', currency: 'EUR', flag: '🇮🇪' },
  EE: { name: 'Estonia', currency: 'EUR', flag: '🇪🇪' },
  LV: { name: 'Latvia', currency: 'EUR', flag: '🇱🇻' },
  LT: { name: 'Lithuania', currency: 'EUR', flag: '🇱🇹' },
  LU: { name: 'Luxembourg', currency: 'EUR', flag: '🇱🇺' },
  CY: { name: 'Cyprus', currency: 'EUR', flag: '🇨🇾' },
  SK: { name: 'Slovakia', currency: 'EUR', flag: '🇸🇰' },
  SI: { name: 'Slovenia', currency: 'EUR', flag: '🇸🇮' },
  CR: { name: 'Costa Rica', currency: 'CRC', flag: '🇨🇷' },
  PY: { name: 'Paraguay', currency: 'PYG', flag: '🇵🇾' },
  UY: { name: 'Uruguay', currency: 'UYU', flag: '🇺🇾' },
  VE: { name: 'Venezuela', currency: 'VES', flag: '🇻🇪' },
  LK: { name: 'Sri Lanka', currency: 'LKR', flag: '🇱🇰' },
  BD: { name: 'Bangladesh', currency: 'BDT', flag: '🇧🇩' },
  AZ: { name: 'Azerbaijan', currency: 'AZN', flag: '🇦🇿' },
  GE: { name: 'Georgia', currency: 'GEL', flag: '🇬🇪' },
  RS: { name: 'Serbia', currency: 'RSD', flag: '🇷🇸' },
};

const FX_SYMBOLS = Object.fromEntries(
  [...new Set(Object.values(COUNTRY_META).map(c => c.currency))].map(ccy => [ccy, `${ccy}USD=X`])
);

// Handle both plain numbers and thousands-separated (480,000 LBP or 12,000 KRW)
const NUM = '\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,3})?';
const CCY = 'USD|GBP|EUR|JPY|CHF|CNY|INR|AUD|CAD|NZD|BRL|MXN|ZAR|TRY|KRW|SGD|HKD|TWD|THB|IDR|NOK|SEK|DKK|PLN|CZK|HUF|RON|PHP|VND|MYR|PKR|ILS|ARS|COP|CLP|UAH|NGN|KES|AED|SAR|QAR|KWD|BHD|OMR|EGP|JOD|LBP|RUB|PEN|CRC|PYG|UYU|VES|LKR|BDT|AZN|GEL|RSD';
const PRICE_PATTERNS = [
  new RegExp(`(${NUM})\\s*(${CCY})`, 'i'),
  new RegExp(`(${CCY})\\s*(${NUM})`, 'i'),
];

function parseNum(s) { return parseFloat(s.replace(/[,\s]/g, '')); }

function matchPrice(text, url) {
  for (const re of PRICE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const [price, currency] = /^\d/.test(match[1])
        ? [parseNum(match[1]), match[2].toUpperCase()]
        : [parseNum(match[2]), match[1].toUpperCase()];
      if (price > 0 && price < 10_000_000) return { price, currency, source: url || '' };
    }
  }
  return null;
}

async function searchExa(query, includeDomains = null) {
  const apiKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  if (!apiKey) throw new Error('EXA_API_KEYS or EXA_API_KEY not set');

  const body = {
    query,
    numResults: 5,
    type: 'auto',
    contents: { summary: { query: 'What is the current Big Mac price in local currency and USD?' } },
  };
  if (includeDomains) body.includeDomains = includeDomains;

  const resp = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.warn(`  EXA ${resp.status}: ${text.slice(0, 100)}`);
    return null;
  }
  return resp.json();
}

/**
 * PRIMARY: Fetch Big Mac Index from The Economist's official GitHub CSV.
 * This is the canonical, reliable data source — updated semi-annually.
 * CSV columns: date,iso_a3,currency_code,name,local_price,dollar_ex,dollar_price,...
 */
async function fetchEconomistCsv() {
  const CSV_URLS = [
    'https://raw.githubusercontent.com/TheEconomist/big-mac-data/refs/heads/main/output-data/big-mac-full-index.csv',
    'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/output-data/big-mac-full-index.csv',
  ];
  console.log('\n📥 Fetching Economist Big Mac Index CSV...');

  let text;
  for (const url of CSV_URLS) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
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
  if (lines.length < 2) throw new Error('Economist CSV has no data rows');

  // Parse header
  const header = lines[0].split(',');
  const dateIdx = header.indexOf('date');
  const a3Idx = header.indexOf('iso_a3');
  const ccyIdx = header.indexOf('currency_code');
  const nameIdx = header.indexOf('name');
  const localIdx = header.indexOf('local_price');
  const exIdx = header.indexOf('dollar_ex');
  const usdIdx = header.indexOf('dollar_price');

  if ([dateIdx, a3Idx, ccyIdx, localIdx, usdIdx].some(i => i < 0)) {
    throw new Error('Economist CSV missing required columns');
  }

  // Find the latest date
  const allDates = [...new Set(lines.slice(1).map(l => l.split(',')[dateIdx]).filter(Boolean))];
  const latestDate = allDates.sort().at(-1);
  console.log(`  Latest Economist data: ${latestDate} (${allDates.length} periods available)`);

  // Parse rows for the latest date
  const rows = lines.slice(1).filter(l => l.startsWith(latestDate));
  const results = [];

  for (const row of rows) {
    const cols = row.split(',');
    const a3 = cols[a3Idx]?.trim();
    const currencyCode = cols[ccyIdx]?.trim();
    const countryName = cols[nameIdx]?.trim();
    const localPrice = parseFloat(cols[localIdx]);
    const dollarEx = parseFloat(cols[exIdx]);
    const dollarPrice = parseFloat(cols[usdIdx]);

    if (!a3 || isNaN(localPrice) || isNaN(dollarPrice)) continue;

    const a2 = A3_TO_A2[a3] || null;
    const meta = a2 ? COUNTRY_META[a2] : null;

    results.push({
      code: a2 || a3,
      name: meta?.name || countryName || a3,
      currency: meta?.currency || currencyCode || '',
      flag: meta?.flag || '🌍',
      localPrice: +localPrice.toFixed(4),
      usdPrice: +dollarPrice.toFixed(4),
      fxRate: isNaN(dollarEx) ? 0 : +dollarEx.toFixed(6),
      sourceSite: 'economist-github',
      available: dollarPrice > 0,
    });
  }

  console.log(`  ✅ Economist CSV: ${results.length} countries, ${results.filter(r => r.available).length} with prices`);
  return { results, date: latestDate };
}

/**
 * FALLBACK: EXA search for Big Mac prices (original method).
 * Only used if Economist CSV is unavailable.
 */
async function fetchExaPrices(prevSnapshot) {
  const fxRates = await getSharedFxRates(FX_SYMBOLS, FX_FALLBACKS);
  const results = [];

  for (const [code, meta] of Object.entries(COUNTRY_META)) {
    await sleep(EXA_DELAY_MS);
    console.log(`\n  Processing ${meta.flag} ${meta.name} (${meta.currency})...`);

    const fxRate = fxRates[meta.currency] ?? FX_FALLBACKS[meta.currency] ?? null;
    let localPrice = null;
    let usdPrice = null;
    let sourceSite = '';

    try {
      const query = `Big Mac price ${meta.name} ${meta.currency} 2025 2026`;

      const exaResult = await searchExa(query);
      await sleep(EXA_DELAY_MS);

      if (exaResult?.results?.length) {
        for (const result of exaResult.results) {
          const summary = result?.summary;
          if (!summary || typeof summary !== 'string') continue;
          const hit = matchPrice(summary, result.url || '');
          if (hit?.currency === meta.currency) {
            localPrice = hit.price;
            sourceSite = hit.source;
            break;
          }
        }
      }
    } catch (err) {
      console.warn(`  [${code}] EXA error: ${err.message}`);
    }

    if (usdPrice === null) {
      usdPrice = localPrice !== null && fxRate ? +(localPrice * fxRate).toFixed(4) : null;
    }

    if (usdPrice !== null && (usdPrice < USD_MIN || usdPrice > USD_MAX)) {
      console.warn(`  [PRICE] ANOMALY ${meta.flag} ${meta.name}: $${usdPrice} out of range [$${USD_MIN}-$${USD_MAX}] — dropping price`);
      usdPrice = null;
      localPrice = null;
    }

    const status = localPrice !== null ? `${localPrice} ${meta.currency} = $${usdPrice}` : 'N/A';
    console.log(`  Big Mac: ${status}`);

    results.push({
      code,
      name: meta.name,
      currency: meta.currency,
      flag: meta.flag,
      localPrice: localPrice !== null ? +localPrice.toFixed(4) : null,
      usdPrice,
      fxRate: fxRate || 0,
      sourceSite,
      available: usdPrice !== null,
    });
  }

  return results;
}

async function fetchBigMacPrices(prevSnapshot) {
  let results = [];
  let dataSource = 'none';

  // ── Tier 1: Economist GitHub CSV (canonical, reliable) ──
  try {
    const csvData = await fetchEconomistCsv();
    if (csvData.results.filter(r => r.available).length >= 10) {
      results = csvData.results;
      dataSource = 'economist-csv';
    }
  } catch (err) {
    console.warn(`\n⚠️ Economist CSV failed: ${err.message}`);
  }

  // ── Tier 2: EXA search fallback ──
  if (results.filter(r => r.available).length < 10) {
    console.log('\n📥 Falling back to EXA search for Big Mac prices...');
    try {
      results = await fetchExaPrices(prevSnapshot);
      if (results.filter(r => r.available).length >= 5) {
        dataSource = 'exa-search';
      }
    } catch (err) {
      console.warn(`\n⚠️ EXA search failed: ${err.message}`);
    }
  }

  if (results.filter(r => r.available).length === 0) {
    throw new Error('No Big Mac price data available from any source');
  }

  console.log(`\n📊 Data source: ${dataSource} (${results.filter(r => r.available).length} countries with prices)`);

  const withData = results.filter(r => r.usdPrice != null);
  const cheapest = withData.length ? withData.reduce((a, b) => a.usdPrice < b.usdPrice ? a : b).code : '';
  const mostExpensive = withData.length ? withData.reduce((a, b) => a.usdPrice > b.usdPrice ? a : b).code : '';

  // Compute WoW per country — requires at least 6 days between snapshots
  const prevAge = prevSnapshot?.fetchedAt ? Date.now() - new Date(prevSnapshot.fetchedAt).getTime() : 0;
  const hasPrevData = prevSnapshot?.countries?.length > 0;
  const prevTooRecent = prevAge > 0 && prevAge < MIN_WOW_AGE_MS;

  if (hasPrevData && prevTooRecent) {
    console.warn(`  [WoW] Skipping WoW — previous snapshot is only ${Math.round(prevAge / 3600000)}h old (need 144h+)`);
  }

  let wowAvailable = hasPrevData && !prevTooRecent;
  let suspiciousCount = 0;
  let suspiciousNames = '';

  if (wowAvailable) {
    const prevMap = Object.fromEntries(prevSnapshot.countries.map(c => [c.code, c.usdPrice]));
    const rawWowValues = [];

    for (const r of results) {
      if (r.usdPrice != null && prevMap[r.code] != null && prevMap[r.code] > 0) {
        const raw = +((r.usdPrice - prevMap[r.code]) / prevMap[r.code] * 100).toFixed(2);
        rawWowValues.push(raw);
        if (Math.abs(raw) > WOW_ANOMALY_THRESHOLD) {
          console.warn(`  [WoW] ANOMALY ${r.flag} ${r.name}: ${raw}% (prev=$${prevMap[r.code]} now=$${r.usdPrice}) — hiding WoW for this country`);
          suspiciousCount++;
          suspiciousNames += (suspiciousNames ? ', ' : '') + `${r.name} ${raw}%`;
          r.wowPct = null;
        } else {
          r.wowPct = raw;
        }
      } else {
        r.wowPct = null;
      }
    }

    if (suspiciousCount > 0) {
      console.error(`  [WoW] ADMIN ALERT: ${suspiciousCount} country/ies had anomalous WoW (>±${WOW_ANOMALY_THRESHOLD}%): ${suspiciousNames}`);
    }

    const rawAvg = rawWowValues.length > 0
      ? +(rawWowValues.reduce((s, v) => s + v, 0) / rawWowValues.length).toFixed(2)
      : 0;
    if (Math.abs(rawAvg) > WOW_ANOMALY_THRESHOLD) {
      console.error(`  [WoW] ADMIN ALERT: Global WoW raw avg ${rawAvg}% exceeds ±${WOW_ANOMALY_THRESHOLD}% — disabling WoW entirely, likely systematic data bug`);
      wowAvailable = false;
    }
  }

  const wowCountries = wowAvailable ? results.filter(r => r.wowPct != null) : [];
  const wowAvgPct = wowCountries.length > 0
    ? +(wowCountries.reduce((s, r) => s + r.wowPct, 0) / wowCountries.length).toFixed(2)
    : 0;

  return {
    countries: results,
    fetchedAt: new Date().toISOString(),
    cheapestCountry: cheapest,
    mostExpensiveCountry: mostExpensive,
    wowAvgPct,
    wowAvailable,
    prevFetchedAt: wowAvailable ? (prevSnapshot.fetchedAt ?? '') : '',
  };
}

const prevSnapshot = await readSeedSnapshot(CANONICAL_KEY);

export function declareRecords(data) {
  return data?.countries?.filter(c => c.available).length || 0;
}

await runSeed('economic', 'bigmac', CANONICAL_KEY, () => fetchBigMacPrices(prevSnapshot), {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data?.countries?.length > 0,
  recordCount: (data) => data?.countries?.filter(c => c.available).length || 0,
  declareRecords,
  sourceVersion: 'economist-bigmac-v2',
  schemaVersion: 1,
  maxStaleMin: 10080,
  extraKeys: prevSnapshot ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => prevSnapshot,
    ttl: CACHE_TTL * 2,
    declareRecords,
  }] : undefined,
});
