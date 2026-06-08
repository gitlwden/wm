export const config = { runtime: 'nodejs' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createMarketServiceRoutes } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { marketHandler } from '../../../server/worldmonitor/market/v1/handler';

export default createDomainGateway(
  createMarketServiceRoutes(marketHandler, serverOptions),
);
