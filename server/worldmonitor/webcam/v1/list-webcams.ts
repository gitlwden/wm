import type { ListWebcamsRequest, ListWebcamsResponse, WebcamEntry, WebcamCluster, ServerContext } from '../../../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const MAX_RESULTS = 2000;
const RESPONSE_CACHE_TTL = 3600; // 1 hour

function getClusterCellSize(zoom: number): number {
  if (zoom < 3) return 8;
  if (zoom <= 4) return 5;
  if (zoom <= 6) return 2;
  if (zoom <= 8) return 0.5;
  return 0; // no clustering
}

function clusterWebcams(
  webcams: Array<{ webcamId: string; title: string; lat: number; lng: number; category: string; country: string }>,
  cellSize: number,
): { singles: WebcamEntry[]; clusters: WebcamCluster[] } {
  if (cellSize <= 0) {
    return {
      singles: webcams.map(w => ({
        webcamId: w.webcamId, title: w.title,
        lat: w.lat, lng: w.lng,
        category: w.category, country: w.country,
      })),
      clusters: [],
    };
  }

  const buckets = new Map<string, typeof webcams>();
  for (const w of webcams) {
    const key = `${Math.floor(w.lat / cellSize)}:${Math.floor(w.lng / cellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(w);
  }

  const singles: WebcamEntry[] = [];
  const clusters: WebcamCluster[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      const w = bucket[0]!;
      singles.push({
        webcamId: w.webcamId, title: w.title,
        lat: w.lat, lng: w.lng,
        category: w.category, country: w.country,
      });
    } else {
      // Circular mean for longitude (antimeridian-safe)
      const toRad = Math.PI / 180;
      const toDeg = 180 / Math.PI;
      let sinSum = 0, cosSum = 0, latSum = 0;
      const catSet = new Set<string>();
      for (const w of bucket) {
        latSum += w.lat;
        sinSum += Math.sin(w.lng * toRad);
        cosSum += Math.cos(w.lng * toRad);
        catSet.add(w.category);
      }
      clusters.push({
        lat: latSum / bucket.length,
        lng: Math.atan2(sinSum, cosSum) * toDeg,
        count: bucket.length,
        categories: [...catSet],
      });
    }
  }

  return { singles, clusters };
}

export async function listWebcams(_ctx: ServerContext, req: ListWebcamsRequest): Promise<ListWebcamsResponse> {
  const { zoom = 3 } = req;

  // Quantize bounds so the GEOSEARCH matches the cache key semantics.
  // Every viewport that maps to the same quantized key gets the same superset query.
  const qW = Math.floor(req.boundW ?? -180);
  const qS = Math.floor(req.boundS ?? -90);
  const qE = Math.ceil(req.boundE ?? 180);
  const qN = Math.ceil(req.boundN ?? 90);

  // Read active version
  const versionResult = await getCachedJson('webcam:cameras:active');
  const version = versionResult != null ? String(versionResult) : null;
  if (!version) {
    return { webcams: [], clusters: [], totalInView: 0 };
  }

  // Check response cache (quantized bbox + zoom + version)
  const cacheKey = `webcam:resp:${version}:${zoom}:${qW}:${qS}:${qE}:${qN}`;
  const cached = await getCachedJson(cacheKey) as ListWebcamsResponse | null;
  if (cached) return cached;

  const geoKey = `webcam:cameras:geo:${version}`;
  const metaKey = `webcam:cameras:meta:${version}`;

  // Load geo index as JSON array [{lon, lat, id}, ...] and filter by bounding box
  const geoData = await getCachedJson(geoKey, true) as Array<{ lon: number; lat: number; id: string }> | null;
  if (!geoData || geoData.length === 0) {
    const empty: ListWebcamsResponse = { webcams: [], clusters: [], totalInView: 0 };
    await setCachedJson(cacheKey, empty, RESPONSE_CACHE_TTL);
    return empty;
  }

  // Filter entries within bounding box (handles antimeridian)
  const inBounds = qW > qE
    ? geoData.filter(e => e.lon >= qW || e.lon <= qE)
    : geoData.filter(e => e.lon >= qW && e.lon <= qE && e.lat >= qS && e.lat <= qN);
  const ids = inBounds.slice(0, MAX_RESULTS).map(e => e.id);

  if (ids.length === 0) {
    const empty: ListWebcamsResponse = { webcams: [], clusters: [], totalInView: 0 };
    await setCachedJson(cacheKey, empty, RESPONSE_CACHE_TTL);
    return empty;
  }

  // Fetch metadata as JSON object {id: {title, lat, lng, category, country}, ...}
  const metaObj = await getCachedJson(metaKey, true) as Record<string, { title?: string; lat?: number; lng?: number; category?: string; country?: string }> | null;
  const webcams: Array<{ webcamId: string; title: string; lat: number; lng: number; category: string; country: string }> = [];

  for (const id of ids) {
    const meta = metaObj?.[id];
    if (!meta) continue;
    webcams.push({
      webcamId: id,
      title: meta.title || '',
      lat: meta.lat || 0,
      lng: meta.lng || 0,
      category: meta.category || 'other',
      country: meta.country || '',
    });
  }

  const cellSize = getClusterCellSize(zoom);
  const { singles, clusters } = clusterWebcams(webcams, cellSize);

  const result: ListWebcamsResponse = {
    webcams: singles,
    clusters,
    totalInView: webcams.length,
  };

  setCachedJson(cacheKey, result, RESPONSE_CACHE_TTL).catch(err => {
    console.warn('[webcam] response cache write failed:', err);
  });

  return result;
}

function equirectangularWidthKm(s: number, n: number, w: number, e: number): number {
  const midLat = ((s + n) / 2) * Math.PI / 180;
  return Math.abs(e - w) * 111.32 * Math.cos(midLat);
}
