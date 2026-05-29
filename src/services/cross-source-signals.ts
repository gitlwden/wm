import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import {
  IntelligenceServiceClient,
  type ListCrossSourceSignalsResponse,
  type CrossSourceSignalSeverity,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListCrossSourceSignalsResponse>({ name: 'Cross-Source Signals', cacheTtlMs: 15 * 60 * 1000, persistCache: true });

export type { ListCrossSourceSignalsResponse };

const EMPTY: ListCrossSourceSignalsResponse = { signals: [], evaluatedAt: 0, compositeCount: 0 };

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function scoreTier(score: number): CrossSourceSignalSeverity {
  if (score >= 3.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL';
  if (score >= 2.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH';
  if (score >= 1.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM';
  return 'CROSS_SOURCE_SIGNAL_SEVERITY_LOW';
}

const BASE_WEIGHT = {
  THERMAL_SPIKE: 3.0,
  VIX_SPIKE: 2.0,
  COMMODITY_SHOCK: 2.0,
  UNREST_SURGE: 2.5,
  CYBER_ESCALATION: 2.5,
  SHIPPING_DISRUPTION: 2.0,
  SANCTIONS_SURGE: 1.5,
  EARTHQUAKE_SIGNIFICANT: 2.5,
  INFRASTRUCTURE_OUTAGE: 2.0,
  WILDFIRE_ESCALATION: 1.5,
  WEATHER_EXTREME: 1.5,
  RISK_SCORE_SPIKE: 2.5,
  RADIATION_ANOMALY: 3.5,
  OREF_ALERT_CLUSTER: 3.5,
  MEDIA_TONE_DETERIORATION: 1.5,
};

/**
 * Build cross-source signals from bootstrap hydration data.
 * Used as fallback when the server-side seed hasn't populated Redis yet.
 */
function buildFromBootstrap(): ListCrossSourceSignalsResponse {
  const signals: ListCrossSourceSignalsResponse['signals'] = [];
  const now = Date.now();

  // Thermal spikes
  const thermal = getHydratedData('thermalEscalation') as { clusters?: Array<{ status?: string; anomalyScore?: number; region?: string; name?: string }> } | undefined;
  if (thermal?.clusters) {
    for (const c of thermal.clusters.filter(cl => cl.status === 'spike' || safeNum(cl.anomalyScore) > 2).slice(0, 3)) {
      const score = BASE_WEIGHT.THERMAL_SPIKE * Math.min(3, safeNum(c.anomalyScore) || 1.5);
      signals.push({
        id: `thermal:${(c.name || c.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE',
        theater: c.region || c.name || 'Global',
        summary: `Thermal spike detected: ${c.name || c.region || 'unknown'} — anomaly score ${safeNum(c.anomalyScore).toFixed(1)}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Market: VIX + stress
  const market = getHydratedData('marketQuotes') as { quotes?: Array<{ symbol?: string; display?: string; price?: number; change?: number }> } | undefined;
  if (market?.quotes) {
    const vix = market.quotes.find(q => q.symbol === '^VIX' || q.symbol === 'VIX' || q.display === 'VIX');
    if (vix && safeNum(vix.price) >= 25) {
      const vixVal = safeNum(vix.price);
      const score = BASE_WEIGHT.VIX_SPIKE * (vixVal > 40 ? 2 : vixVal > 30 ? 1.5 : 1.2);
      signals.push({
        id: 'vix:global-markets',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
        theater: 'Global Markets',
        summary: `VIX elevated at ${vixVal.toFixed(1)} — fear index signals market stress`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
    const spx = market.quotes.find(q => q.symbol === '^GSPC' || q.symbol === 'SPX' || q.display === 'S&P 500');
    if (spx && Math.abs(safeNum(spx.change)) >= 2) {
      const change = safeNum(spx.change);
      const score = BASE_WEIGHT.COMMODITY_SHOCK * Math.min(2, Math.abs(change) / 2);
      signals.push({
        id: 'market-stress:global',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS',
        theater: 'Global Markets',
        summary: `Market stress: S&P 500 ${change > 0 ? '+' : ''}${change.toFixed(1)}% — ${Math.abs(change) > 4 ? 'extreme' : 'significant'} session move`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Commodities
  const commodities = getHydratedData('commodityQuotes') as { quotes?: Array<{ symbol?: string; display?: string; change?: number }> } | undefined;
  if (commodities?.quotes) {
    for (const q of commodities.quotes.filter(q => Math.abs(safeNum(q.change)) >= 5).slice(0, 2)) {
      const change = safeNum(q.change);
      const score = BASE_WEIGHT.COMMODITY_SHOCK * Math.min(2, Math.abs(change) / 5);
      signals.push({
        id: `commodity:${(q.symbol || q.display || 'unknown').replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK',
        theater: (q.symbol === 'OIL' || q.symbol === 'CL=F' || q.display?.includes('Oil')) ? 'Persian Gulf' : 'Global Markets',
        summary: `Commodity shock: ${q.display || q.symbol} ${change > 0 ? '+' : ''}${change.toFixed(1)}%`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Unrest
  const unrest = getHydratedData('unrestEvents') as { events?: Array<{ region?: string; country?: string }> } | undefined;
  if (unrest?.events?.length) {
    const regionCounts = new Map<string, number>();
    for (const e of unrest.events) {
      const region = e.region || e.country || 'Global';
      regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
    }
    for (const [region, count] of [...regionCounts.entries()].filter(([, c]) => c >= 3).slice(0, 3)) {
      const score = BASE_WEIGHT.UNREST_SURGE * Math.min(2, 1 + count / 10);
      signals.push({
        id: `unrest:${region.replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE',
        theater: region,
        summary: `Unrest surge: ${count} events in ${region} in past 24h`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Cyber threats
  const cyber = getHydratedData('cyberThreats') as { threats?: Array<{ severity?: string; targetCountry?: string; region?: string }> } | undefined;
  if (cyber?.threats) {
    const critical = cyber.threats.filter(t => t.severity === 'critical' || t.severity === 'high');
    if (critical.length > 0) {
      const regionCounts = new Map<string, number>();
      for (const t of critical) {
        const region = t.targetCountry || t.region || 'Global';
        regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
      }
      for (const [region, count] of [...regionCounts.entries()].slice(0, 2)) {
        const score = BASE_WEIGHT.CYBER_ESCALATION * Math.min(2, 1 + count / 5);
        signals.push({
          id: `cyber:${region.replace(/\s+/g, '-').toLowerCase()}`,
          type: 'CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION',
          theater: region,
          summary: `Cyber escalation: ${count} critical/high threat${count > 1 ? 's' : ''} targeting ${region}`,
          severity: scoreTier(score),
          severityScore: score,
          detectedAt: now,
          contributingTypes: [],
          signalCount: 0,
        });
      }
    }
  }

  // Shipping
  const shipping = getHydratedData('shippingRates') as { routes?: Array<{ disrupted?: boolean; status?: string; name?: string; route?: string }> } | undefined;
  if (shipping?.routes) {
    const disrupted = shipping.routes.filter(r => r.disrupted || r.status === 'disrupted');
    if (disrupted.length > 0) {
      const isRedSea = disrupted.some(r => String(r.name || r.route || '').toLowerCase().includes('red sea'));
      const theater = isRedSea ? 'Red Sea' : 'Global';
      const score = BASE_WEIGHT.SHIPPING_DISRUPTION * Math.min(2, 1 + disrupted.length / 3);
      signals.push({
        id: `shipping:${theater.replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
        theater,
        summary: `Shipping disruption: ${disrupted.length} route${disrupted.length > 1 ? 's' : ''} affected`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Sanctions
  const sanctions = getHydratedData('sanctionsPressure') as { newEntryCount?: number; countries?: Array<{ countryName?: string }> } | undefined;
  if (sanctions && safeNum(sanctions.newEntryCount) >= 5) {
    const topCountry = sanctions.countries?.[0];
    const score = BASE_WEIGHT.SANCTIONS_SURGE * Math.min(2, 1 + safeNum(sanctions.newEntryCount) / 20);
    signals.push({
      id: `sanctions:global`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE',
      theater: topCountry?.countryName || 'Global',
      summary: `Sanctions surge: ${sanctions.newEntryCount} new designations`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: now,
      contributingTypes: [],
      signalCount: 0,
    });
  }

  // Earthquakes
  const quakes = getHydratedData('earthquakes') as { earthquakes?: Array<{ magnitude?: number; place?: string; region?: string }> } | undefined;
  if (quakes?.earthquakes) {
    for (const q of quakes.earthquakes.filter(q => safeNum(q.magnitude) >= 6.5).slice(0, 2)) {
      const mag = safeNum(q.magnitude);
      const score = BASE_WEIGHT.EARTHQUAKE_SIGNIFICANT * (mag >= 7.5 ? 2 : mag >= 7.0 ? 1.5 : 1.2);
      signals.push({
        id: `quake:${q.place?.replace(/\s+/g, '-').toLowerCase() || 'unknown'}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT',
        theater: q.place || q.region || 'Global',
        summary: `M${mag.toFixed(1)} earthquake — ${q.place || 'unknown location'}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Infrastructure outages
  const outages = getHydratedData('outages') as { outages?: Array<{ severity?: string; region?: string; country?: string }> } | undefined;
  if (outages?.outages) {
    const major = outages.outages.filter(o => o.severity === 'major' || o.severity === 'critical');
    if (major.length > 0) {
      const regionCounts = new Map<string, number>();
      for (const o of major) {
        const region = o.region || o.country || 'Global';
        regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
      }
      for (const [region, count] of [...regionCounts.entries()].slice(0, 2)) {
        const score = BASE_WEIGHT.INFRASTRUCTURE_OUTAGE * Math.min(2, 1 + count / 3);
        signals.push({
          id: `outage:${region.replace(/\s+/g, '-').toLowerCase()}`,
          type: 'CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE',
          theater: region,
          summary: `Infrastructure outage: ${count} major service failure${count > 1 ? 's' : ''} in ${region}`,
          severity: scoreTier(score),
          severityScore: score,
          detectedAt: now,
          contributingTypes: [],
          signalCount: 0,
        });
      }
    }
  }

  // Security advisories
  const advisories = getHydratedData('securityAdvisories') as { advisories?: Array<{ level?: string; country?: string; region?: string; reason?: string }> } | undefined;
  if (advisories?.advisories) {
    const critical = advisories.advisories.filter(a => String(a.level || '').toLowerCase() === 'do not travel');
    for (const a of critical.slice(0, 3)) {
      const score = BASE_WEIGHT.OREF_ALERT_CLUSTER;
      signals.push({
        id: `advisory:${(a.country || a.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER',
        theater: a.region || a.country || 'Global',
        summary: `"Do Not Travel" advisory: ${a.country || a.region || 'unknown'}${a.reason ? ` — ${a.reason}` : ''}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Risk scores
  const risk = getHydratedData('riskScores') as { ciiScores?: Array<{ combinedScore?: number; trend?: string; region?: string }> } | undefined;
  if (risk?.ciiScores) {
    const spiking = risk.ciiScores.filter(s => safeNum(s.combinedScore) > 80 || s.trend === 'TREND_DIRECTION_RISING');
    for (const s of spiking.slice(0, 3)) {
      const score = BASE_WEIGHT.RISK_SCORE_SPIKE * Math.min(2, safeNum(s.combinedScore) / 60);
      signals.push({
        id: `risk:${(s.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE',
        theater: s.region || 'Global',
        summary: `Risk score spike: ${s.region || 'unknown'} CII score ${safeNum(s.combinedScore).toFixed(0)}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Wildfires
  const fires = getHydratedData('wildfires') as { fires?: Array<{ radiativePower?: number; severity?: string; brightness?: number; region?: string }> } | undefined;
  if (fires?.fires) {
    const extreme = fires.fires.filter(f => safeNum(f.radiativePower) > 5000 || f.severity === 'extreme' || safeNum(f.brightness) > 400);
    if (extreme.length >= 5) {
      const regionCounts = new Map<string, number>();
      for (const f of extreme) {
        const region = f.region || 'Global';
        regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
      }
      for (const [region, count] of [...regionCounts.entries()].filter(([, c]) => c >= 5).slice(0, 2)) {
        const score = BASE_WEIGHT.WILDFIRE_ESCALATION * Math.min(2, 1 + count / 50);
        signals.push({
          id: `wildfire:${region.replace(/\s+/g, '-').toLowerCase()}`,
          type: 'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION',
          theater: region,
          summary: `Wildfire escalation: ${count} extreme thermal detections in ${region}`,
          severity: scoreTier(score),
          severityScore: score,
          detectedAt: now,
          contributingTypes: [],
          signalCount: 0,
        });
      }
    }
  }

  // Weather
  const weather = getHydratedData('weatherAlerts') as { alerts?: Array<{ severity?: string; category?: string; area?: string; region?: string }> } | undefined;
  if (weather?.alerts) {
    const extreme = weather.alerts.filter(a => a.severity === 'extreme' || a.category === 'extreme');
    if (extreme.length > 0) {
      const regionCounts = new Map<string, number>();
      for (const a of extreme) {
        const region = a.area || a.region || 'Global';
        regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
      }
      for (const [region, count] of [...regionCounts.entries()].slice(0, 2)) {
        const score = BASE_WEIGHT.WEATHER_EXTREME * Math.min(2, 1 + count / 5);
        signals.push({
          id: `weather:${region.replace(/\s+/g, '-').toLowerCase()}`,
          type: 'CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME',
          theater: region,
          summary: `Extreme weather: ${count} active extreme alert${count > 1 ? 's' : ''} in ${region}`,
          severity: scoreTier(score),
          severityScore: score,
          detectedAt: now,
          contributingTypes: [],
          signalCount: 0,
        });
      }
    }
  }

  // GDELT media tone
  const gdelt = getHydratedData('gdeltIntel') as { topics?: Array<{ avgTone?: number; tone?: number; region?: string; label?: string }> } | undefined;
  if (gdelt?.topics) {
    for (const topic of gdelt.topics.filter(t => safeNum(t.avgTone ?? t.tone) < -3).slice(0, 2)) {
      const tone = safeNum(topic.avgTone ?? topic.tone);
      const score = BASE_WEIGHT.MEDIA_TONE_DETERIORATION * Math.min(2, Math.abs(tone) / 3);
      signals.push({
        id: `gdelt-tone:${(topic.label || 'unknown').replace(/\s+/g, '-').toLowerCase().slice(0, 40)}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
        theater: topic.region || 'Global',
        summary: `Media tone deterioration: "${topic.label || 'Unknown'}" avg tone ${tone.toFixed(1)}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Radiation
  const radiation = getHydratedData('radiationWatch') as { observations?: Array<{ severity?: string; alert?: boolean; locationName?: string; country?: string; value?: number }> } | undefined;
  if (radiation?.observations) {
    const anomalies = radiation.observations.filter(o => o.alert || o.severity === 'alert' || o.severity === 'spike');
    for (const a of anomalies.slice(0, 2)) {
      const score = BASE_WEIGHT.RADIATION_ANOMALY;
      signals.push({
        id: `radiation:${(a.locationName || a.country || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY',
        theater: a.country || 'Global',
        summary: `Radiation anomaly: ${a.locationName || a.country || 'unknown station'}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: now,
        contributingTypes: [],
        signalCount: 0,
      });
    }
  }

  // Sort by severity
  signals.sort((a, b) => b.severityScore - a.severityScore);

  return {
    signals: signals.slice(0, 30),
    evaluatedAt: now,
    compositeCount: 0,
  };
}

export async function fetchCrossSourceSignals(): Promise<ListCrossSourceSignalsResponse> {
  const hydrated = getHydratedData('crossSourceSignals') as ListCrossSourceSignalsResponse | undefined;
  if (hydrated?.signals?.length) return hydrated;

  const result = await breaker.execute(async () => {
    return await client.listCrossSourceSignals({}, { signal: AbortSignal.timeout(15_000) });
  }, EMPTY, { shouldCache: (r) => r.signals.length > 0 });

  // If RPC returned empty, fall back to building signals from bootstrap data
  if (result.signals.length === 0) {
    const fallback = buildFromBootstrap();
    if (fallback.signals.length > 0) return fallback;
  }

  return result;
}
