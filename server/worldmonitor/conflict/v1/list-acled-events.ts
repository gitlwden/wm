/**
 * RPC: listAcledEvents (GDELT-backed)
 *
 * Fetches conflict events (battles, explosions, violence) from the GDELT
 * GKG GeoJSON endpoint and maps them to the AcledConflictEvent proto type.
 * Falls back gracefully to empty results on upstream failure.
 *
 * Migrated from ACLED → GDELT (2026-05-27).
 */

import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const GDELT_GKG_URL = 'https://api.gdeltproject.org/api/v1/gkg_geojson';
const REDIS_CACHE_KEY = 'conflict:gdelt:v1';
const REDIS_CACHE_TTL = 900; // 15 min
const GDELT_TIMEOUT_MS = 20_000;

const fallbackCache = new Map<string, { data: ListAcledEventsResponse; ts: number }>();

/** Map GDELT location name to a conflict event type. */
function classifyEventType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('bomb') || lower.includes('explos') || lower.includes('shell') || lower.includes('airstrik') || lower.includes('missil'))
    return 'Explosions/Remote violence';
  if (lower.includes('battle') || lower.includes('clash') || lower.includes('offensiv') || lower.includes('siege'))
    return 'Battles';
  if (lower.includes('attack') || lower.includes('kill') || lower.includes('massacr') || lower.includes('violence'))
    return 'Violence against civilians';
  return 'Battles';
}

/** Extract country name from GDELT's "City, Region, Country" format. */
function extractCountry(name: string): string {
  const parts = name.split(',').map(p => p.trim());
  return parts[parts.length - 1] || name;
}

/** Extract admin1 (region/state) from GDELT name. */
function extractAdmin1(name: string): string {
  const parts = name.split(',').map(p => p.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

async function fetchGdeltConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  const params = new URLSearchParams({
    query: 'battle OR explosion OR airstrike OR "violence against" OR shelling OR offensive',
    maxrows: '2500',
  });
  const url = `${GDELT_GKG_URL}?${params}`;

  let data: any;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(GDELT_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`GDELT HTTP ${resp.status}`);
    data = await resp.json();
  } catch {
    return [];
  }

  const features = data?.features || [];
  const now = Date.now();
  const startMs = req.start ?? (now - 30 * 24 * 60 * 60 * 1000);
  const endMs = req.end ?? now;
  const countryFilter = req.country?.toLowerCase();

  // Aggregate by location cell (0.1° grid) to deduplicate mentions
  const cellMap = new Map<string, {
    name: string; lat: number; lon: number; count: number; worstTone: number; urls: string[]
  }>();

  for (const f of features) {
    const name = f.properties?.name || '';
    if (!name) continue;

    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const country = extractCountry(name);
    if (countryFilter && country.toLowerCase() !== countryFilter) continue;

    // GDELT GKG v1 doesn't include article dates in geojson; use seendate from properties
    const seenDate = f.properties?.seendate;
    if (seenDate) {
      const seenMs = new Date(seenDate.replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T')).getTime();
      if (Number.isFinite(seenMs) && (seenMs < startMs || seenMs > endMs)) continue;
    }

    const key = `${Math.round(lat * 10)}:${Math.round(lon * 10)}`;
    const existing = cellMap.get(key);
    if (existing) {
      existing.count++;
      const tone = f.properties?.urltone ?? 0;
      if (tone < existing.worstTone) existing.worstTone = tone;
      const articleUrl = f.properties?.url;
      if (articleUrl && existing.urls.length < 3) existing.urls.push(articleUrl);
    } else {
      cellMap.set(key, {
        name, lat, lon, count: 1,
        worstTone: f.properties?.urltone ?? 0,
        urls: f.properties?.url ? [f.properties.url] : [],
      });
    }
  }

  const events: AcledConflictEvent[] = [];
  for (const [, cell] of cellMap) {
    if (cell.count < 3) continue; // Skip noise — require at least 3 mentions

    events.push({
      id: `gdelt-${cell.lat.toFixed(2)}-${cell.lon.toFixed(2)}`,
      eventType: classifyEventType(cell.name),
      country: extractCountry(cell.name),
      location: { latitude: cell.lat, longitude: cell.lon },
      occurredAt: now,
      fatalities: 0, // GDELT doesn't track fatalities
      actors: [],
      source: 'GDELT',
      admin1: extractAdmin1(cell.name),
    });
  }

  return events;
}

export async function listAcledEvents(
  _ctx: ServerContext,
  req: ListAcledEventsRequest,
): Promise<ListAcledEventsResponse> {
  const cacheKey = `${REDIS_CACHE_KEY}:${req.country || 'all'}:${req.start || 0}:${req.end || 0}`;
  try {
    const result = await cachedFetchJson<ListAcledEventsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const events = await fetchGdeltConflicts(req);
        return events.length > 0 ? { events, pagination: undefined } : null;
      },
    );
    if (result) {
      if (fallbackCache.size > 50) fallbackCache.clear();
      fallbackCache.set(cacheKey, { data: result, ts: Date.now() });
    }
    return result || fallbackCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  } catch {
    return fallbackCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  }
}
