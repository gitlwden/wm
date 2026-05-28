import type {
  Forecast,
  ForecastServiceHandler,
  ServerContext,
  GetForecastsRequest,
  GetForecastsResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'forecast:predictions:v2';

function filterForecasts(forecasts: Forecast[], req: GetForecastsRequest): Forecast[] {
  let result = forecasts;
  if (req.domain) result = result.filter(f => f.domain === req.domain);
  if (req.region) result = result.filter(f => f.region.toLowerCase().includes(req.region.toLowerCase()));
  return result;
}

export const getForecasts: ForecastServiceHandler['getForecasts'] = async (
  _ctx: ServerContext,
  req: GetForecastsRequest,
): Promise<GetForecastsResponse> => {
  const now = Date.now();
  try {
    const data = await getCachedJson(REDIS_KEY) as { predictions: Forecast[]; generatedAt: number } | null;
    if (!data?.predictions) {
      // Dev fallback: serve mock data when Redis is empty/unavailable
      if (!process.env.UPSTASH_REDIS_REST_URL) {
        const { MOCK_FORECASTS } = await import('./dev-mock-forecasts');
        return { forecasts: filterForecasts(MOCK_FORECASTS, req), generatedAt: now };
      }
      return { forecasts: [], generatedAt: 0 };
    }

    return { forecasts: filterForecasts(data.predictions, req), generatedAt: data.generatedAt || 0 };
  } catch {
    // Dev fallback on any error
    if (!process.env.UPSTASH_REDIS_REST_URL) {
      const { MOCK_FORECASTS } = await import('./dev-mock-forecasts');
      return { forecasts: filterForecasts(MOCK_FORECASTS, req), generatedAt: now };
    }
    return { forecasts: [], generatedAt: 0 };
  }
};
