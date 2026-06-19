# WorldMonitor API Reference

Base URL: `https://wm-worldmonitor-847.netlify.app`

## Authentication

All endpoints except the public ones require an API key passed via header:

```
X-WorldMonitor-Key: <your-api-key>
```

Public endpoints (no key needed): `/api/bootstrap`, `/api/health`, `/api/version`

Premium endpoints (marked with `🔒`) require a Pro-tier API key (`wm_` prefix).

## Common Query Parameters

Most GET endpoints support these standard parameters:
- `lang` — response language (default: `en`)
- `variant` — data variant filter

POST endpoints accept JSON body with `Content-Type: application/json`.

---

## Market

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 1 | `/api/market/v1/list-market-quotes` | GET | Key | Stock market quotes (major indices + watchlist) |
| 2 | `/api/market/v1/list-crypto-quotes` | GET | Key | Cryptocurrency price quotes |
| 3 | `/api/market/v1/list-crypto-sectors` | GET | Key | Crypto sector breakdown |
| 4 | `/api/market/v1/list-defi-tokens` | GET | Key | DeFi token prices |
| 5 | `/api/market/v1/list-ai-tokens` | GET | Key | AI-related token prices |
| 6 | `/api/market/v1/list-other-tokens` | GET | Key | Other crypto tokens |
| 7 | `/api/market/v1/list-commodity-quotes` | GET | Key | Commodity prices (gold, oil, etc.) |
| 8 | `/api/market/v1/list-stablecoin-markets` | GET | Key | Stablecoin market data |
| 9 | `/api/market/v1/get-sector-summary` | GET | Key | Market sector performance summary |
| 10 | `/api/market/v1/get-fear-greed-index` | GET | Key | Market fear & greed index |
| 11 | `/api/market/v1/get-market-breadth-history` | GET | Key | Historical market breadth data |
| 12 | `/api/market/v1/list-gulf-quotes` | GET | Key | Gulf region market quotes |
| 13 | `/api/market/v1/list-etf-flows` | GET | Key | ETF fund flow data |
| 14 | `/api/market/v1/list-earnings-calendar` | GET | Key | Upcoming earnings reports |
| 15 | `/api/market/v1/get-cot-positioning` | GET | Key | COT (Commitment of Traders) data |
| 16 | `/api/market/v1/get-gold-intelligence` | GET | Key | Gold market analysis |
| 17 | `/api/market/v1/get-hyperliquid-flow` | GET | Key | Hyperliquid DEX flow data |
| 18 | `/api/market/v1/get-country-stock-index` | GET | Key | Country-specific stock index. Params: `country` |
| 19 | 🔒 `/api/market/v1/analyze-stock` | POST | Pro | AI stock analysis. Body: `{"symbol":"AAPL","name":"Apple","includeNews":true}` |
| 20 | 🔒 `/api/market/v1/get-stock-analysis-history` | GET | Pro | Cached stock analysis history. Params: `symbol` |
| 21 | 🔒 `/api/market/v1/backtest-stock` | POST | Pro | Stock strategy backtest. Body: `{"symbol":"AAPL"}` |
| 22 | 🔒 `/api/market/v1/get-insider-transactions` | GET | Pro | Insider trading data. Params: `symbol` |
| 23 | 🔒 `/api/market/v1/list-stored-stock-backtests` | GET | Pro | List stored backtest results |

## Intelligence

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 24 | `/api/intelligence/v1/get-country-intel-brief` | GET | Key | Country intelligence brief. Params: `country` |
| 25 | `/api/intelligence/v1/get-gdelt-topic-timeline` | GET | Key | GDELT topic timeline. Params: `topic` |
| 26 | `/api/intelligence/v1/get-country-risk` | GET | Key | Country risk assessment. Params: `country` |
| 27 | `/api/intelligence/v1/get-risk-scores` | GET | Key | Global risk scores |
| 28 | `/api/intelligence/v1/get-pizzint-status` | GET | Key | OSINT monitoring status |
| 29 | `/api/intelligence/v1/classify-event` | POST | Key | Classify event severity. Body: `{"title":"..."}` |
| 30 | `/api/intelligence/v1/search-gdelt-documents` | GET | Key | Search GDELT documents. Params: `query` |
| 31 | `/api/intelligence/v1/get-country-facts` | GET | Key | Country factual data. Params: `country` |
| 32 | `/api/intelligence/v1/list-security-advisories` | GET | Key | Security advisories feed |
| 33 | `/api/intelligence/v1/list-satellites` | GET | Key | Satellite tracking data |
| 34 | `/api/intelligence/v1/list-gps-interference` | GET | Key | GPS jamming/spoofing events |
| 35 | `/api/intelligence/v1/list-cross-source-signals` | GET | Key | Cross-source intelligence signals |
| 36 | `/api/intelligence/v1/list-oref-alerts` | GET | Key | OREF rocket/siren alerts |
| 37 | `/api/intelligence/v1/list-telegram-feed` | GET | Key | Telegram OSINT feed |
| 38 | `/api/intelligence/v1/get-company-enrichment` | GET | Key | Company enrichment data. Params: `company` |
| 39 | `/api/intelligence/v1/list-company-signals` | GET | Key | Company intelligence signals |
| 40 | `/api/intelligence/v1/get-social-velocity` | GET | Key | Social media velocity tracker |
| 41 | `/api/intelligence/v1/get-country-energy-profile` | GET | Key | Country energy profile. Params: `country` |
| 42 | `/api/intelligence/v1/compute-energy-shock` | GET | Key | Energy shock simulation |
| 43 | `/api/intelligence/v1/get-country-port-activity` | GET | Key | Country port activity. Params: `country` |
| 44 | 🔒 `/api/intelligence/v1/deduct-situation` | POST | Public/Pro | AI geopolitical deduction. Body: `{"query":"What is the current risk level?"}` |
| 45 | 🔒 `/api/intelligence/v1/list-market-implications` | GET | Pro | Market implications of geopolitical events |
| 46 | 🔒 `/api/intelligence/v1/get-regional-snapshot` | GET | Pro | Regional intelligence snapshot. Params: `region` |
| 47 | 🔒 `/api/intelligence/v1/get-regime-history` | GET | Pro | Regime stability history. Params: `country` |
| 48 | 🔒 `/api/intelligence/v1/get-regional-brief` | GET | Pro | Regional AI brief. Params: `region` |

## Economic

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 49 | `/api/economic/v1/get-fred-series` | GET | Key | FRED economic data series. Params: `seriesId` |
| 50 | `/api/economic/v1/get-bls-series` | GET | Key | BLS labor statistics. Params: `seriesId` |
| 51 | `/api/economic/v1/get-energy-prices` | GET | Key | Global energy prices |
| 52 | `/api/economic/v1/get-macro-signals` | GET | Key | Macroeconomic signals |
| 53 | `/api/economic/v1/get-bis-policy-rates` | GET | Key | BIS central bank policy rates |
| 54 | `/api/economic/v1/get-bis-exchange-rates` | GET | Key | BIS exchange rates |
| 55 | `/api/economic/v1/get-bis-credit` | GET | Key | BIS credit indicators |
| 56 | `/api/economic/v1/list-world-bank-indicators` | GET | Key | World Bank development indicators |
| 57 | `/api/economic/v1/get-energy-capacity` | GET | Key | Energy generation capacity |
| 58 | `/api/economic/v1/list-grocery-basket-prices` | GET | Key | Grocery basket price comparison |
| 59 | `/api/economic/v1/list-bigmac-prices` | GET | Key | Big Mac index prices |
| 60 | `/api/economic/v1/list-fuel-prices` | GET | Key | Fuel prices by country |
| 61 | `/api/economic/v1/get-fao-food-price-index` | GET | Key | FAO food price index |
| 62 | `/api/economic/v1/get-crude-inventories` | GET | Key | Crude oil inventories |
| 63 | `/api/economic/v1/get-nat-gas-storage` | GET | Key | Natural gas storage levels |
| 64 | `/api/economic/v1/get-eu-yield-curve` | GET | Key | EU sovereign yield curve |
| 65 | `/api/economic/v1/get-economic-calendar` | GET | Key | Economic event calendar |
| 66 | `/api/economic/v1/get-ecb-fx-rates` | GET | Key | ECB foreign exchange rates |
| 67 | `/api/economic/v1/get-eurostat-country-data` | GET | Key | Eurostat country data |
| 68 | `/api/economic/v1/get-eu-gas-storage` | GET | Key | EU gas storage levels |
| 69 | `/api/economic/v1/get-oil-stocks-analysis` | GET | Key | Oil stocks analysis |
| 70 | `/api/economic/v1/get-oil-inventories` | GET | Key | Global oil inventories |
| 71 | `/api/economic/v1/get-energy-crisis-policies` | GET | Key | Energy crisis policy tracker |
| 72 | `/api/economic/v1/get-eu-fsi` | GET | Key | EU financial stability index |
| 73 | `/api/economic/v1/get-economic-stress` | GET | Key | Economic stress indicators |
| 74 | 🔒 `/api/economic/v1/get-national-debt` | GET | Pro | National debt data |

## Military & Conflict

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 75 | `/api/military/v1/get-theater-posture` | GET | Key | Global military theater posture |
| 76 | `/api/military/v1/get-usni-fleet-report` | GET | Key | USNI fleet deployment report |
| 77 | `/api/military/v1/list-defense-patents` | GET | Key | Defense technology patents |
| 78 | `/api/military/v1/list-military-flights` | GET | Key | Military aircraft tracking |
| 79 | `/api/military/v1/list-military-bases` | GET | Key | Global military bases |
| 80 | `/api/military/v1/get-aircraft-details` | GET | Key | Aircraft type details |
| 81 | `/api/military/v1/get-wingbits-status` | GET | Key | Wingbits ADS-B network status |
| 82 | `/api/military/v1/get-wingbits-live-flight` | GET | Key | Wingbits live flight data |
| 83 | `/api/conflict/v1/list-acled-events` | GET | Key | ACLED conflict events |
| 84 | `/api/conflict/v1/list-ucdp-events` | GET | Key | UCDP conflict events |
| 85 | `/api/conflict/v1/get-humanitarian-summary` | GET | Key | Humanitarian situation summary |
| 86 | `/api/conflict/v1/list-iran-events` | GET | Key | Iran-related conflict events |

## Supply Chain & Trade

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 87 | `/api/supply-chain/v1/get-shipping-rates` | GET | Key | Global shipping freight rates |
| 88 | `/api/supply-chain/v1/list-pipelines` | GET | Key | Energy pipeline infrastructure |
| 89 | `/api/supply-chain/v1/get-pipeline-detail` | GET | Key | Pipeline details. Params: `id` |
| 90 | `/api/supply-chain/v1/list-storage-facilities` | GET | Key | Energy storage facilities |
| 91 | `/api/supply-chain/v1/get-storage-facility-detail` | GET | Key | Storage facility details. Params: `id` |
| 92 | `/api/supply-chain/v1/list-fuel-shortages` | GET | Key | Active fuel shortage reports |
| 93 | `/api/supply-chain/v1/get-fuel-shortage-detail` | GET | Key | Fuel shortage details. Params: `id` |
| 94 | `/api/supply-chain/v1/list-energy-disruptions` | GET | Key | Energy disruption events |
| 95 | `/api/supply-chain/v1/get-chokepoint-status` | GET | Key | Maritime chokepoint status |
| 96 | `/api/supply-chain/v1/get-chokepoint-history` | GET | Key | Chokepoint historical data |
| 97 | `/api/supply-chain/v1/get-critical-minerals` | GET | Key | Critical mineral supply data |
| 98 | `/api/supply-chain/v1/get-shipping-stress` | GET | Key | Shipping stress indicators |
| 99 | 🔒 `/api/supply-chain/v1/get-country-chokepoint-index` | GET | Pro | Country chokepoint dependency. Params: `country` |
| 100 | 🔒 `/api/supply-chain/v1/get-bypass-options` | GET | Pro | Chokepoint bypass routes. Params: `country` |
| 101 | 🔒 `/api/supply-chain/v1/get-country-cost-shock` | GET | Pro | Country supply chain cost shock. Params: `country` |
| 102 | 🔒 `/api/supply-chain/v1/get-route-explorer-lane` | GET | Pro | Shipping lane explorer. Params: `origin`, `destination` |
| 103 | 🔒 `/api/supply-chain/v1/get-route-impact` | GET | Pro | Route disruption impact. Params: `origin`, `destination` |
| 104 | 🔒 `/api/supply-chain/v1/get-country-products` | GET | Pro | Country product exports. Params: `iso2` |
| 105 | 🔒 `/api/supply-chain/v1/get-multi-sector-cost-shock` | GET | Pro | Multi-sector cost shock. Params: `iso2` |
| 106 | 🔒 `/api/supply-chain/v1/get-sector-dependency` | GET | Pro | Sector supply dependency. Params: `sector` |
| 107 | `/api/trade/v1/get-tariff-trends` | GET | Key | Tariff trend analysis |
| 108 | `/api/trade/v1/get-trade-flows` | GET | Key | Global trade flow data |
| 109 | `/api/trade/v1/get-trade-barriers` | GET | Key | Trade barrier analysis |
| 110 | `/api/trade/v1/get-trade-restrictions` | GET | Key | Trade restriction tracker |
| 111 | `/api/trade/v1/get-customs-revenue` | GET | Key | Customs revenue data |
| 112 | 🔒 `/api/trade/v1/list-comtrade-flows` | GET | Pro | UN Comtrade flow data. Params: `reporter` |
| 113 | 🔒 `/api/v2/shipping/route-intelligence` | GET | Pro | Shipping route intelligence |
| 114 | 🔒 `/api/v2/shipping/webhooks` | GET | Pro | Shipping webhook management |

## Infrastructure & Cyber

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 115 | `/api/infrastructure/v1/list-service-statuses` | GET | Key | Internet service status |
| 116 | `/api/infrastructure/v1/list-internet-outages` | GET | Key | Internet outage events |
| 117 | `/api/infrastructure/v1/list-internet-ddos-attacks` | GET | Key | DDoS attack events |
| 118 | `/api/infrastructure/v1/list-internet-traffic-anomalies` | GET | Key | Internet traffic anomalies |
| 119 | `/api/infrastructure/v1/get-temporal-baseline` | GET | Key | Infrastructure baseline data |
| 120 | `/api/infrastructure/v1/get-cable-health` | GET | Key | Submarine cable health |
| 121 | `/api/infrastructure/v1/list-temporal-anomalies` | GET | Key | Temporal anomaly detection |
| 122 | `/api/infrastructure/v1/get-ip-geo` | GET | Key | IP geolocation. Params: `ip` |
| 123 | `/api/infrastructure/v1/reverse-geocode` | GET | Key | Reverse geocoding. Params: `lat`, `lon` |
| 124 | `/api/infrastructure/v1/get-bootstrap-data` | GET | Key | Infrastructure bootstrap data |
| 125 | `/api/cyber/v1/list-cyber-threats` | GET | Key | Cyber threat intelligence |

## Climate & Environment

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 126 | `/api/climate/v1/list-climate-anomalies` | GET | Key | Climate anomaly data |
| 127 | `/api/climate/v1/list-climate-disasters` | GET | Key | Climate disaster events |
| 128 | `/api/climate/v1/get-co2-monitoring` | GET | Key | CO2 monitoring data |
| 129 | `/api/climate/v1/get-ocean-ice-data` | GET | Key | Ocean and ice data |
| 130 | `/api/climate/v1/list-air-quality-data` | GET | Key | Air quality measurements |
| 131 | `/api/climate/v1/list-climate-news` | GET | Key | Climate news feed |
| 132 | `/api/radiation/v1/list-radiation-observations` | GET | Key | Radiation monitoring |
| 133 | `/api/thermal/v1/list-thermal-escalations` | GET | Key | Thermal escalation events |
| 134 | `/api/natural/v1/list-natural-events` | GET | Key | Natural disaster events |
| 135 | `/api/wildfire/v1/list-fire-detections` | GET | Key | FIRMS wildfire detections |
| 136 | `/api/displacement/v1/get-displacement-summary` | GET | Key | Displacement summary |
| 137 | `/api/displacement/v1/get-population-exposure` | GET | Key | Population exposure data |

## Aviation & Maritime

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 138 | `/api/aviation/v1/list-airport-delays` | GET | Key | Airport delay data |
| 139 | `/api/aviation/v1/get-airport-ops-summary` | GET | Key | Airport operations summary |
| 140 | `/api/aviation/v1/list-airport-flights` | GET | Key | Airport flight list. Params: `airport` |
| 141 | `/api/aviation/v1/get-carrier-ops` | GET | Key | Airline carrier operations |
| 142 | `/api/aviation/v1/get-flight-status` | GET | Key | Flight status lookup. Params: `flight` |
| 143 | `/api/aviation/v1/track-aircraft` | GET | Key | Aircraft tracking. Params: `icao24` |
| 144 | `/api/aviation/v1/search-flight-prices` | GET | Key | Flight price search |
| 145 | `/api/aviation/v1/search-google-flights` | GET | Key | Google Flights search |
| 146 | `/api/aviation/v1/search-google-dates` | GET | Key | Google Flights date search |
| 147 | `/api/aviation/v1/list-aviation-news` | GET | Key | Aviation news feed |
| 148 | `/api/aviation/v1/get-youtube-live-stream-info` | GET | Key | YouTube live stream info |
| 149 | `/api/maritime/v1/get-vessel-snapshot` | GET | Key | Vessel position snapshot. Params: `mmsi` |
| 150 | `/api/maritime/v1/list-navigational-warnings` | GET | Key | Navigational warnings |

## Research & News

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 151 | `/api/research/v1/list-arxiv-papers` | GET | Key | ArXiv research papers |
| 152 | `/api/research/v1/list-trending-repos` | GET | Key | Trending GitHub repos |
| 153 | `/api/research/v1/list-tech-events` | GET | Key | Technology events |
| 154 | `/api/research/v1/list-hackernews-items` | GET | Key | Hacker News top items |
| 155 | `/api/news/v1/list-feed-digest` | GET | Key | News feed digest. Params: `variant`, `lang` |
| 156 | `/api/news/v1/summarize-article-cache` | GET | Key | Cached article summary. Params: `url` |

## Seismology & Unrest

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 157 | `/api/seismology/v1/list-earthquakes` | GET | Key | Earthquake data |
| 158 | `/api/unrest/v1/list-unrest-events` | GET | Key | Civil unrest events |

## Sanctions & Displacement

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 159 | `/api/sanctions/v1/list-sanctions-pressure` | GET | Key | Sanctions pressure index |
| 160 | `/api/sanctions/v1/lookup-sanction-entity` | GET | Key | Sanctions entity lookup. Params: `q` |

## Health & Giving

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 161 | `/api/health/v1/list-disease-outbreaks` | GET | Key | Disease outbreak tracker |
| 162 | `/api/health/v1/list-air-quality-alerts` | GET | Key | Air quality alerts |
| 163 | `/api/giving/v1/get-giving-summary` | GET | Key | Charitable giving summary |
| 164 | `/api/positive-events/v1/list-positive-geo-events` | GET | Key | Positive geopolitical events |

## Prediction & Forecast

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 165 | `/api/prediction/v1/list-prediction-markets` | GET | Key | Prediction market data (Polymarket/Kalshi) |
| 166 | `/api/forecast/v1/get-forecasts` | GET | Key | Forecast data |
| 167 | `/api/forecast/v1/get-simulation-package` | GET | Key | Simulation package data |
| 168 | `/api/forecast/v1/get-simulation-outcome` | GET | Key | Simulation outcome data |
| 169 | 🔒 `/api/forecast/v1/trigger-simulation` | POST | Pro | Trigger simulation run |

## Imagery & Webcam

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 170 | `/api/imagery/v1/search-imagery` | GET | Key | Satellite imagery search |
| 171 | `/api/webcam/v1/get-webcam-image` | GET | Key | Webcam image. Params: `id` |
| 172 | `/api/webcam/v1/list-webcams` | GET | Key | Webcam listing |

## Consumer Prices

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 173 | `/api/consumer-prices/v1/get-consumer-price-overview` | GET | Key | Consumer price overview |
| 174 | `/api/consumer-prices/v1/get-consumer-price-basket-series` | GET | Key | Price basket time series |
| 175 | `/api/consumer-prices/v1/list-consumer-price-categories` | GET | Key | Price category breakdown |
| 176 | `/api/consumer-prices/v1/list-consumer-price-movers` | GET | Key | Top price movers |
| 177 | `/api/consumer-prices/v1/list-retailer-price-spreads` | GET | Key | Retailer price spreads |
| 178 | `/api/consumer-prices/v1/get-consumer-price-freshness` | GET | Key | Data freshness indicator |

## Resilience

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 179 | 🔒 `/api/resilience/v1/get-resilience-score` | GET | Pro | Country resilience score. Params: `countryCode` |
| 180 | 🔒 `/api/resilience/v1/get-resilience-ranking` | GET | Pro | Global resilience ranking |
| 181 | `/api/resilience/v1/get-runtime-manifest` | GET | Public | Runtime manifest |

## Scenario Engine

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 182 | `/api/scenario/v1/list-scenario-templates` | GET | Key | Available scenario templates |
| 183 | 🔒 `/api/scenario/v1/run-scenario` | POST | Pro | Run scenario simulation. Body: `{"scenarioId":"..."}` |
| 184 | 🔒 `/api/scenario/v1/get-scenario-status` | GET | Pro | Scenario run status. Params: `jobId` |

## Public Endpoints

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| 185 | `/api/bootstrap` | GET | Public | Aggregated startup data (~120 keys). Params: `keys`, `tier` |
| 186 | `/api/health` | GET | Public | Service health check |
| 187 | `/api/version` | GET | Public | App version info |

---

## Usage Examples

```bash
# Get market quotes
curl -H "X-WorldMonitor-Key: wm_xxx" \
  "https://wm-worldmonitor-847.netlify.app/api/market/v1/list-market-quotes"

# AI geopolitical deduction
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-WorldMonitor-Key: wm_xxx" \
  -d '{"query":"What is the current global risk level?"}' \
  "https://wm-worldmonitor-847.netlify.app/api/intelligence/v1/deduct-situation"

# Country resilience score
curl -H "X-WorldMonitor-Key: wm_xxx" \
  "https://wm-worldmonitor-847.netlify.app/api/resilience/v1/get-resilience-score?countryCode=US"

# Stock analysis (Pro)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-WorldMonitor-Key: wm_xxx" \
  -d '{"symbol":"AAPL","name":"Apple","includeNews":true}' \
  "https://wm-worldmonitor-847.netlify.app/api/market/v1/analyze-stock"
```
