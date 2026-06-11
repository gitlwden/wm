/**
 * Netlify Function — catch-all API gateway.
 *
 * Aggregates all domain RPC handlers into a single function.
 * Netlify routes /api/* to this function via netlify.toml rewrite.
 *
 * This avoids the 118-function limit that broke Vercel Hobby plan.
 */

import { createDomainGateway, serverOptions } from '../server/gateway';

// Domain route imports
import { createWildfireServiceRoutes } from '../src/generated/server/worldmonitor/wildfire/v1/service_server';
import { wildfireHandler } from '../server/worldmonitor/wildfire/v1/handler';

import { createInfrastructureServiceRoutes } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { infrastructureHandler } from '../server/worldmonitor/infrastructure/v1/handler';

import { createMilitaryServiceRoutes } from '../src/generated/server/worldmonitor/military/v1/service_server';
import { militaryHandler } from '../server/worldmonitor/military/v1/handler';

import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { climateHandler } from '../server/worldmonitor/climate/v1/handler';

import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
import { conflictHandler } from '../server/worldmonitor/conflict/v1/handler';

import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { intelligenceHandler } from '../server/worldmonitor/intelligence/v1/handler';

import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { marketHandler } from '../server/worldmonitor/market/v1/handler';

import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler';

import { createSeismologyServiceRoutes } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { seismologyHandler } from '../server/worldmonitor/seismology/v1/handler';

import { createNaturalServiceRoutes } from '../src/generated/server/worldmonitor/natural/v1/service_server';
import { naturalHandler } from '../server/worldmonitor/natural/v1/handler';

import { createCyberServiceRoutes } from '../src/generated/server/worldmonitor/cyber/v1/service_server';
import { cyberHandler } from '../server/worldmonitor/cyber/v1/handler';

import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server';
import { displacementHandler } from '../server/worldmonitor/displacement/v1/handler';

import { createEconomicServiceRoutes } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { economicHandler } from '../server/worldmonitor/economic/v1/handler';

import { createSanctionsServiceRoutes } from '../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { sanctionsHandler } from '../server/worldmonitor/sanctions/v1/handler';

import { createRadiationServiceRoutes } from '../src/generated/server/worldmonitor/radiation/v1/service_server';
import { radiationHandler } from '../server/worldmonitor/radiation/v1/handler';

import { createNewsServiceRoutes } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';

import { createHealthServiceRoutes } from '../src/generated/server/worldmonitor/health/v1/service_server';
import { healthHandler } from '../server/worldmonitor/health/v1/handler';

import { createMaritimeServiceRoutes } from '../src/generated/server/worldmonitor/maritime/v1/service_server';
import { maritimeHandler } from '../server/worldmonitor/maritime/v1/handler';

import { createSupplyChainServiceRoutes } from '../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { supplyChainHandler } from '../server/worldmonitor/supply-chain/v1/handler';

import { createImageryServiceRoutes } from '../src/generated/server/worldmonitor/imagery/v1/service_server';
import { imageryHandler } from '../server/worldmonitor/imagery/v1/handler';

import { createResilienceServiceRoutes } from '../src/generated/server/worldmonitor/resilience/v1/service_server';
import { resilienceHandler } from '../server/worldmonitor/resilience/v1/handler';

import { createConsumerPricesServiceRoutes } from '../src/generated/server/worldmonitor/consumer_prices/v1/service_server';
import { consumerPricesHandler } from '../server/worldmonitor/consumer-prices/v1/handler';

import { createForecastServiceRoutes } from '../src/generated/server/worldmonitor/forecast/v1/service_server';
import { forecastHandler } from '../server/worldmonitor/forecast/v1/handler';

import { createGivingServiceRoutes } from '../src/generated/server/worldmonitor/giving/v1/service_server';
import { givingHandler } from '../server/worldmonitor/giving/v1/handler';

import { createPositiveEventsServiceRoutes } from '../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { positiveEventsHandler } from '../server/worldmonitor/positive-events/v1/handler';

import { createPredictionServiceRoutes } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import { predictionHandler } from '../server/worldmonitor/prediction/v1/handler';

import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { researchHandler } from '../server/worldmonitor/research/v1/handler';

import { createScenarioServiceRoutes } from '../src/generated/server/worldmonitor/scenario/v1/service_server';
import { scenarioHandler } from '../server/worldmonitor/scenario/v1/handler';

import { createThermalServiceRoutes } from '../src/generated/server/worldmonitor/thermal/v1/service_server';
import { thermalHandler } from '../server/worldmonitor/thermal/v1/handler';

import { createTradeServiceRoutes } from '../src/generated/server/worldmonitor/trade/v1/service_server';
import { tradeHandler } from '../server/worldmonitor/trade/v1/handler';

import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { unrestHandler } from '../server/worldmonitor/unrest/v1/handler';

import { createLeadsServiceRoutes } from '../src/generated/server/worldmonitor/leads/v1/service_server';
import { leadsHandler } from '../server/worldmonitor/leads/v1/handler';

import { createShippingV2ServiceRoutes } from '../src/generated/server/worldmonitor/shipping/v2/service_server';
import { shippingV2Handler } from '../server/worldmonitor/shipping/v2/handler';

import { createWebcamServiceRoutes } from '../src/generated/server/worldmonitor/webcam/v1/service_server';
import { webcamHandler } from '../server/worldmonitor/webcam/v1/handler';

// Merge all domain routes into a single gateway
const allRoutes = [
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
  ...createMilitaryServiceRoutes(militaryHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
  ...createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
  ...createMarketServiceRoutes(marketHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createNaturalServiceRoutes(naturalHandler, serverOptions),
  ...createCyberServiceRoutes(cyberHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createEconomicServiceRoutes(economicHandler, serverOptions),
  ...createSanctionsServiceRoutes(sanctionsHandler, serverOptions),
  ...createRadiationServiceRoutes(radiationHandler, serverOptions),
  ...createNewsServiceRoutes(newsHandler, serverOptions),
  ...createHealthServiceRoutes(healthHandler, serverOptions),
  ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
  ...createSupplyChainServiceRoutes(supplyChainHandler, serverOptions),
  ...createImageryServiceRoutes(imageryHandler, serverOptions),
  ...createResilienceServiceRoutes(resilienceHandler, serverOptions),
  ...createConsumerPricesServiceRoutes(consumerPricesHandler, serverOptions),
  ...createForecastServiceRoutes(forecastHandler, serverOptions),
  ...createGivingServiceRoutes(givingHandler, serverOptions),
  ...createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createScenarioServiceRoutes(scenarioHandler, serverOptions),
  ...createThermalServiceRoutes(thermalHandler, serverOptions),
  ...createTradeServiceRoutes(tradeHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createLeadsServiceRoutes(leadsHandler, serverOptions),
  ...createShippingV2ServiceRoutes(shippingV2Handler, serverOptions),
  ...createWebcamServiceRoutes(webcamHandler, serverOptions),
];

const gateway = createDomainGateway(allRoutes);

// Standalone route handlers (not part of the RPC gateway).
// .js files exist in the repo; .ts-only files are compiled by esbuild.
const STANDALONE_ROUTES: Record<string, () => Promise<{ default: (req: Request) => Promise<Response> }>> = {
  '/api/bootstrap':               () => import('../api/bootstrap.js'),
  '/api/health':                  () => import('../api/health.js'),
  '/api/version':                 () => import('../api/version.js'),
  '/api/gpsjam':                  () => import('../api/gpsjam.js'),
  '/api/wm-session':              () => import('../api/wm-session.js'),
  '/api/chat-analyst':            () => import('../api/chat-analyst.ts'),
  '/api/latest-brief':            () => import('../api/latest-brief.ts'),
  '/api/create-checkout':         () => import('../api/create-checkout.ts'),
  '/api/customer-portal':         () => import('../api/customer-portal.ts'),
  '/api/notification-channels':   () => import('../api/notification-channels.ts'),
  '/api/notify':                  () => import('../api/notify.ts'),
  '/api/user-prefs':              () => import('../api/user-prefs.ts'),
  '/api/symbol-search':           () => import('../api/symbol-search.ts'),
  '/api/widget-agent':            () => import('../api/widget-agent.ts'),
  '/api/mcp-proxy':               () => import('../api/mcp-proxy.ts'),
  '/api/invalidate-user-api-key-cache': () => import('../api/invalidate-user-api-key-cache.ts'),
  '/api/oauth-protected-resource':() => import('../api/oauth-protected-resource.ts'),
  '/api/seed-contract-probe':     () => import('../api/seed-contract-probe.ts'),
  // Standalone .js routes (legacy edge functions)
  '/api/telegram-feed':           () => import('../api/telegram-feed.js'),
  '/api/download':                () => import('../api/download.js'),
  '/api/fwdstart':                () => import('../api/fwdstart.js'),
  '/api/geo':                     () => import('../api/geo.js'),
  '/api/og-story':                () => import('../api/og-story.js'),
  '/api/opensky':                 () => import('../api/opensky.js'),
  '/api/oref-alerts':             () => import('../api/oref-alerts.js'),
  '/api/reverse-geocode':         () => import('../api/reverse-geocode.js'),
  '/api/rss-proxy':               () => import('../api/rss-proxy.js'),
  '/api/supply-chain/hormuz-tracker': () => import('../api/supply-chain/hormuz-tracker.js'),
  '/api/story':                   () => import('../api/story.js'),
  '/api/mcp':                     () => import('../api/mcp.ts'),
  '/mcp':                         () => import('../api/mcp.ts'),
};

// Netlify Function handler
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Check standalone routes first
  const standaloneImport = STANDALONE_ROUTES[pathname];
  if (standaloneImport) {
    const mod = await standaloneImport();
    return mod.default(req);
  }

  // Fall through to gateway for all RPC routes
  return gateway(req);
};

export const config = {
  path: '/api/*',
};
// relay deploy trigger Thu Jun 11 21:12:23     2026
