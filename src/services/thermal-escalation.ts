import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { fetchAllFires, flattenFires } from '@/services/wildfires';
import { createCircuitBreaker } from '@/utils';
import {
  ThermalServiceClient,
  type ThermalConfidence as ProtoThermalConfidence,
  type ThermalContext as ProtoThermalContext,
  type ThermalEscalationCluster as ProtoThermalEscalationCluster,
  type ThermalStatus as ProtoThermalStatus,
  type ThermalStrategicRelevance as ProtoThermalStrategicRelevance,
} from '@/generated/client/worldmonitor/thermal/v1/service_client';
import type { FireDetection, ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';

export type ThermalStatus = 'normal' | 'elevated' | 'spike' | 'persistent';
export type ThermalContext =
  | 'wildland'
  | 'urban_edge'
  | 'industrial'
  | 'energy_adjacent'
  | 'conflict_adjacent'
  | 'logistics_adjacent'
  | 'mixed';
export type ThermalConfidence = 'low' | 'medium' | 'high';
export type ThermalStrategicRelevance = 'low' | 'medium' | 'high';

export interface ThermalEscalationCluster {
  id: string;
  countryCode: string;
  countryName: string;
  regionLabel: string;
  lat: number;
  lon: number;
  observationCount: number;
  uniqueSourceCount: number;
  maxBrightness: number;
  avgBrightness: number;
  maxFrp: number;
  totalFrp: number;
  nightDetectionShare: number;
  baselineExpectedCount: number;
  baselineExpectedFrp: number;
  countDelta: number;
  frpDelta: number;
  zScore: number;
  persistenceHours: number;
  status: ThermalStatus;
  context: ThermalContext;
  confidence: ThermalConfidence;
  strategicRelevance: ThermalStrategicRelevance;
  nearbyAssets: string[];
  narrativeFlags: string[];
  firstDetectedAt: Date;
  lastDetectedAt: Date;
}

export interface ThermalEscalationWatch {
  fetchedAt: Date;
  observationWindowHours: number;
  sourceVersion: string;
  clusters: ThermalEscalationCluster[];
  summary: {
    clusterCount: number;
    elevatedCount: number;
    spikeCount: number;
    persistentCount: number;
    conflictAdjacentCount: number;
    highRelevanceCount: number;
  };
}

const client = new ThermalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ThermalEscalationWatch>({
  name: 'Thermal Escalation',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const FALLBACK_CLUSTER_RADIUS_KM = 20;
const FALLBACK_OBSERVATION_WINDOW_HOURS = 24;

const FALLBACK_REGION_COUNTRY: Record<string, { code: string; name: string }> = {
  Ukraine: { code: 'UA', name: 'Ukraine' },
  Russia: { code: 'RU', name: 'Russia' },
  Iran: { code: 'IR', name: 'Iran' },
  'Israel/Gaza': { code: 'IL', name: 'Israel / Gaza' },
  Syria: { code: 'SY', name: 'Syria' },
  Taiwan: { code: 'TW', name: 'Taiwan' },
  'North Korea': { code: 'KP', name: 'North Korea' },
  'Saudi Arabia': { code: 'SA', name: 'Saudi Arabia' },
  Turkey: { code: 'TR', name: 'Turkey' },
};

const emptyResult: ThermalEscalationWatch = {
  fetchedAt: new Date(0),
  observationWindowHours: 24,
  sourceVersion: 'thermal-escalation-v1',
  clusters: [],
  summary: {
    clusterCount: 0,
    elevatedCount: 0,
    spikeCount: 0,
    persistentCount: 0,
    conflictAdjacentCount: 0,
    highRelevanceCount: 0,
  },
};

interface HydratedThermalData {
  fetchedAt?: string;
  observationWindowHours?: number;
  sourceVersion?: string;
  clusters?: ProtoThermalEscalationCluster[];
  summary?: {
    clusterCount?: number;
    elevatedCount?: number;
    spikeCount?: number;
    persistentCount?: number;
    conflictAdjacentCount?: number;
    highRelevanceCount?: number;
  };
}

export async function fetchThermalEscalations(maxItems = 12): Promise<ThermalEscalationWatch> {
  const hydrated = getHydratedData('thermalEscalation') as HydratedThermalData | undefined;
  if (hydrated?.clusters?.length) {
    const sliced = (hydrated.clusters ?? []).slice(0, maxItems).map(toCluster);
    return {
      fetchedAt: hydrated.fetchedAt ? new Date(hydrated.fetchedAt) : new Date(0),
      observationWindowHours: hydrated.observationWindowHours ?? 24,
      sourceVersion: hydrated.sourceVersion || 'thermal-escalation-v1',
      clusters: sliced,
      summary: {
        clusterCount: sliced.length,
        elevatedCount: sliced.filter(c => c.status === 'elevated').length,
        spikeCount: sliced.filter(c => c.status === 'spike').length,
        persistentCount: sliced.filter(c => c.status === 'persistent').length,
        conflictAdjacentCount: sliced.filter(c => c.context === 'conflict_adjacent').length,
        highRelevanceCount: sliced.filter(c => c.strategicRelevance === 'high').length,
      },
    };
  }
  const watch = await breaker.execute(async () => {
    const response = await client.listThermalEscalations(
      { maxItems },
      { signal: AbortSignal.timeout(15_000) },
    );
    return {
      fetchedAt: response.fetchedAt ? new Date(response.fetchedAt) : new Date(0),
      observationWindowHours: response.observationWindowHours ?? 24,
      sourceVersion: response.sourceVersion || 'thermal-escalation-v1',
      clusters: (response.clusters ?? []).map(toCluster),
      summary: {
        clusterCount: response.summary?.clusterCount ?? 0,
        elevatedCount: response.summary?.elevatedCount ?? 0,
        spikeCount: response.summary?.spikeCount ?? 0,
        persistentCount: response.summary?.persistentCount ?? 0,
        conflictAdjacentCount: response.summary?.conflictAdjacentCount ?? 0,
        highRelevanceCount: response.summary?.highRelevanceCount ?? 0,
      },
    };
  }, emptyResult, { shouldCache: (r) => r.clusters.length > 0 });

  if (watch.clusters.length > 0) return watch;
  return (await buildFallbackWatchFromFires(maxItems)) ?? watch;
}

function toCluster(cluster: ProtoThermalEscalationCluster): ThermalEscalationCluster {
  return {
    id: cluster.id,
    countryCode: cluster.countryCode,
    countryName: cluster.countryName,
    regionLabel: cluster.regionLabel,
    lat: cluster.centroid?.latitude ?? 0,
    lon: cluster.centroid?.longitude ?? 0,
    observationCount: cluster.observationCount ?? 0,
    uniqueSourceCount: cluster.uniqueSourceCount ?? 0,
    maxBrightness: cluster.maxBrightness ?? 0,
    avgBrightness: cluster.avgBrightness ?? 0,
    maxFrp: cluster.maxFrp ?? 0,
    totalFrp: cluster.totalFrp ?? 0,
    nightDetectionShare: cluster.nightDetectionShare ?? 0,
    baselineExpectedCount: cluster.baselineExpectedCount ?? 0,
    baselineExpectedFrp: cluster.baselineExpectedFrp ?? 0,
    countDelta: cluster.countDelta ?? 0,
    frpDelta: cluster.frpDelta ?? 0,
    zScore: cluster.zScore ?? 0,
    persistenceHours: cluster.persistenceHours ?? 0,
    status: mapStatus(cluster.status),
    context: mapContext(cluster.context),
    confidence: mapConfidence(cluster.confidence),
    strategicRelevance: mapRelevance(cluster.strategicRelevance),
    nearbyAssets: cluster.nearbyAssets ?? [],
    narrativeFlags: cluster.narrativeFlags ?? [],
    firstDetectedAt: new Date(cluster.firstDetectedAt),
    lastDetectedAt: new Date(cluster.lastDetectedAt),
  };
}

function mapStatus(status: ProtoThermalStatus): ThermalStatus {
  switch (status) {
    case 'THERMAL_STATUS_PERSISTENT':
      return 'persistent';
    case 'THERMAL_STATUS_SPIKE':
      return 'spike';
    case 'THERMAL_STATUS_ELEVATED':
      return 'elevated';
    default:
      return 'normal';
  }
}

function mapContext(context: ProtoThermalContext): ThermalContext {
  switch (context) {
    case 'THERMAL_CONTEXT_URBAN_EDGE':
      return 'urban_edge';
    case 'THERMAL_CONTEXT_INDUSTRIAL':
      return 'industrial';
    case 'THERMAL_CONTEXT_ENERGY_ADJACENT':
      return 'energy_adjacent';
    case 'THERMAL_CONTEXT_CONFLICT_ADJACENT':
      return 'conflict_adjacent';
    case 'THERMAL_CONTEXT_LOGISTICS_ADJACENT':
      return 'logistics_adjacent';
    case 'THERMAL_CONTEXT_MIXED':
      return 'mixed';
    default:
      return 'wildland';
  }
}

function mapConfidence(confidence: ProtoThermalConfidence): ThermalConfidence {
  switch (confidence) {
    case 'THERMAL_CONFIDENCE_HIGH':
      return 'high';
    case 'THERMAL_CONFIDENCE_MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}

function mapRelevance(relevance: ProtoThermalStrategicRelevance): ThermalStrategicRelevance {
  switch (relevance) {
    case 'THERMAL_RELEVANCE_HIGH':
      return 'high';
    case 'THERMAL_RELEVANCE_MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}

interface FireCluster {
  detections: FireDetection[];
  lat: number;
  lon: number;
  regionLabel: string;
}

async function buildFallbackWatchFromFires(maxItems: number): Promise<ThermalEscalationWatch | null> {
  const hydrated = getHydratedData('wildfires') as ListFireDetectionsResponse | undefined;
  let detections = hydrated?.fireDetections ?? [];

  if (detections.length === 0) {
    try {
      detections = flattenFires((await fetchAllFires()).regions);
    } catch {
      detections = [];
    }
  }

  const cutoff = Date.now() - FALLBACK_OBSERVATION_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = detections
    .filter((d) => {
      const detectedAt = Number(d.detectedAt);
      const lat = d.location?.latitude;
      const lon = d.location?.longitude;
      return Number.isFinite(detectedAt)
        && detectedAt >= cutoff
        && Number.isFinite(lat)
        && Number.isFinite(lon);
    })
    .sort((a, b) => Number(a.detectedAt) - Number(b.detectedAt));

  if (recent.length === 0) return null;

  const clusters = clusterFallbackFires(recent)
    .map(toFallbackThermalCluster)
    .sort((a, b) => {
      const relevance = relevanceScore(b.strategicRelevance) - relevanceScore(a.strategicRelevance);
      if (relevance !== 0) return relevance;
      const status = statusScore(b.status) - statusScore(a.status);
      if (status !== 0) return status;
      return b.totalFrp - a.totalFrp;
    })
    .slice(0, Math.max(1, maxItems));

  if (clusters.length === 0) return null;

  return {
    fetchedAt: new Date(),
    observationWindowHours: FALLBACK_OBSERVATION_WINDOW_HOURS,
    sourceVersion: 'thermal-escalation-v1:fallback-wildfires',
    clusters,
    summary: summarizeClusters(clusters),
  };
}

function clusterFallbackFires(detections: FireDetection[]): FireCluster[] {
  const clusters: FireCluster[] = [];
  for (const detection of detections) {
    const lat = detection.location?.latitude ?? 0;
    const lon = detection.location?.longitude ?? 0;
    const regionLabel = detection.region || 'Unknown';
    let match: FireCluster | undefined;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      if (cluster.regionLabel !== regionLabel) continue;
      const distance = haversineKm(cluster.lat, cluster.lon, lat, lon);
      if (distance <= FALLBACK_CLUSTER_RADIUS_KM && distance < bestDistance) {
        match = cluster;
        bestDistance = distance;
      }
    }

    if (!match) {
      clusters.push({ detections: [detection], lat, lon, regionLabel });
      continue;
    }

    match.detections.push(detection);
    const count = match.detections.length;
    match.lat = ((match.lat * (count - 1)) + lat) / count;
    match.lon = ((match.lon * (count - 1)) + lon) / count;
  }
  return clusters;
}

function toFallbackThermalCluster(cluster: FireCluster): ThermalEscalationCluster {
  const detections = cluster.detections;
  const country = FALLBACK_REGION_COUNTRY[cluster.regionLabel] ?? { code: 'XX', name: cluster.regionLabel || 'Unknown' };
  const detectedTimes = detections.map((d) => Number(d.detectedAt)).filter(Number.isFinite);
  const firstDetectedAt = new Date(Math.min(...detectedTimes));
  const lastDetectedAt = new Date(Math.max(...detectedTimes));
  const totalFrp = round(detections.reduce((sum, d) => sum + (Number(d.frp) || 0), 0), 1);
  const maxFrp = round(detections.reduce((max, d) => Math.max(max, Number(d.frp) || 0), 0), 1);
  const brightnessValues = detections.map((d) => Number(d.brightness) || 0);
  const maxBrightness = round(Math.max(...brightnessValues), 1);
  const avgBrightness = round(brightnessValues.reduce((sum, value) => sum + value, 0) / brightnessValues.length, 1);
  const observationCount = detections.length;
  const uniqueSourceCount = new Set(detections.map((d) => d.satellite || 'unknown')).size;
  const persistenceHours = Math.max(0, round((lastDetectedAt.getTime() - firstDetectedAt.getTime()) / (60 * 60 * 1000), 1));
  const status = deriveFallbackStatus(observationCount, totalFrp, maxBrightness, persistenceHours);
  const context: ThermalContext = isConflictRegion(cluster.regionLabel) ? 'conflict_adjacent' : 'wildland';
  const strategicRelevance = deriveFallbackRelevance(status, context, totalFrp);

  return {
    id: `fallback:${country.code.toLowerCase()}:${cluster.lat.toFixed(2)}:${cluster.lon.toFixed(2)}`,
    countryCode: country.code,
    countryName: country.name,
    regionLabel: cluster.regionLabel,
    lat: round(cluster.lat, 4),
    lon: round(cluster.lon, 4),
    observationCount,
    uniqueSourceCount,
    maxBrightness,
    avgBrightness,
    maxFrp,
    totalFrp,
    nightDetectionShare: round(detections.filter((d) => String(d.dayNight || '').toUpperCase() === 'N').length / observationCount, 2),
    baselineExpectedCount: 0,
    baselineExpectedFrp: 0,
    countDelta: observationCount,
    frpDelta: totalFrp,
    zScore: 0,
    persistenceHours,
    status,
    context,
    confidence: uniqueSourceCount > 1 || observationCount >= 4 ? 'medium' : 'low',
    strategicRelevance,
    nearbyAssets: [],
    narrativeFlags: [
      ...(context === 'conflict_adjacent' ? ['conflict_adjacent'] : []),
      ...(status !== 'normal' ? [status] : []),
      ...(uniqueSourceCount > 1 ? ['multi_source'] : []),
    ],
    firstDetectedAt,
    lastDetectedAt,
  };
}

function deriveFallbackStatus(observationCount: number, totalFrp: number, maxBrightness: number, persistenceHours: number): ThermalStatus {
  if (persistenceHours >= 12 && (observationCount >= 4 || totalFrp >= 80)) return 'persistent';
  if (observationCount >= 8 || totalFrp >= 150 || maxBrightness >= 380) return 'spike';
  if (observationCount >= 3 || totalFrp >= 50 || maxBrightness >= 360) return 'elevated';
  return 'normal';
}

function deriveFallbackRelevance(status: ThermalStatus, context: ThermalContext, totalFrp: number): ThermalStrategicRelevance {
  if (context === 'conflict_adjacent' && (status === 'spike' || status === 'persistent')) return 'high';
  if (status === 'persistent' || status === 'spike' || totalFrp >= 120) return 'medium';
  return 'low';
}

function summarizeClusters(clusters: ThermalEscalationCluster[]): ThermalEscalationWatch['summary'] {
  return {
    clusterCount: clusters.length,
    elevatedCount: clusters.filter((c) => c.status === 'elevated').length,
    spikeCount: clusters.filter((c) => c.status === 'spike').length,
    persistentCount: clusters.filter((c) => c.status === 'persistent').length,
    conflictAdjacentCount: clusters.filter((c) => c.context === 'conflict_adjacent').length,
    highRelevanceCount: clusters.filter((c) => c.strategicRelevance === 'high').length,
  };
}

function isConflictRegion(region: string): boolean {
  return ['Ukraine', 'Russia', 'Iran', 'Israel/Gaza', 'Syria', 'Taiwan', 'North Korea'].includes(region);
}

function statusScore(status: ThermalStatus): number {
  switch (status) {
    case 'persistent': return 4;
    case 'spike': return 3;
    case 'elevated': return 2;
    default: return 1;
  }
}

function relevanceScore(relevance: ThermalStrategicRelevance): number {
  switch (relevance) {
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
