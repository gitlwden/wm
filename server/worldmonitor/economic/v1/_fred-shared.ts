import type { FredSeries } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export const FRED_KEY_PREFIX = 'economic:fred:v1';

export const FRED_VIX_KEY = 'economic:fred:v1:VIXCLS:0';
export const FRED_HY_SPREAD_KEY = 'economic:fred:v1:BAMLH0A0HYM2:0';
export const FRED_ICSA_KEY = 'economic:fred:v1:ICSA:0';
export const FRED_MORTGAGE_KEY = 'economic:fred:v1:MORTGAGE30US:0';
export const FRED_FEDFUNDS_KEY = 'economic:fred:v1:FEDFUNDS:0';
export const FRED_10Y2Y_KEY = 'economic:fred:v1:T10Y2Y:0';
export const FRED_M2_KEY = 'economic:fred:v1:M2SL:0';
export const FRED_UNRATE_KEY = 'economic:fred:v1:UNRATE:0';
export const FRED_CPI_KEY = 'economic:fred:v1:CPIAUCSL:0';
export const FRED_DGS10_KEY = 'economic:fred:v1:DGS10:0';
export const FRED_WALCL_KEY = 'economic:fred:v1:WALCL:0';

export function fredSeedKey(seriesId: string): string {
  return `${FRED_KEY_PREFIX}:${seriesId}:0`;
}

export function normalizeFredLimit(limit: number): number {
  return limit > 0 ? Math.min(limit, 1000) : 120;
}

export function applyFredObservationLimit(series: FredSeries, limit: number): FredSeries {
  if (limit > 0 && series.observations.length > limit) {
    return { ...series, observations: series.observations.slice(-limit) };
  }
  return series;
}
