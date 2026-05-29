import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  ConflictServiceClient,
  ApiError,
  type AcledConflictEvent as ProtoAcledEvent,
  type UcdpViolenceEvent as ProtoUcdpEvent,
  type HumanitarianCountrySummary as ProtoHumanSummary,
  type ListAcledEventsResponse,
  type ListUcdpEventsResponse,
  type GetHumanitarianSummaryResponse,
  type GetHumanitarianSummaryBatchResponse,
  type IranEvent,
  type ListIranEventsResponse,
} from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { UcdpGeoEvent } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

// ---- Client + Circuit Breakers (per-RPC; HAPI uses per-country map) ----

const client = new ConflictServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const acledBreaker = createCircuitBreaker<ListAcledEventsResponse>({ name: 'GDELT Conflicts', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const ucdpBreaker = createCircuitBreaker<ListUcdpEventsResponse>({ name: 'UCDP Events', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const hapiBreakers = new Map<string, ReturnType<typeof createCircuitBreaker<GetHumanitarianSummaryResponse>>>();
function getHapiBreaker(iso2: string) {
  if (!hapiBreakers.has(iso2)) {
    hapiBreakers.set(iso2, createCircuitBreaker<GetHumanitarianSummaryResponse>({
      name: `HDX HAPI:${iso2}`,
      cacheTtlMs: 10 * 60 * 1000,
      persistCache: true,
    }));
  }
  return hapiBreakers.get(iso2)!;
}
const iranBreaker = createCircuitBreaker<ListIranEventsResponse>({ name: 'Iran Events', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const emptyIranFallback: ListIranEventsResponse = { events: [], scrapedAt: '0' };

export type { IranEvent };

// ---- Exported Types (match legacy shapes exactly) ----

export type ConflictEventType = 'battle' | 'explosion' | 'remote_violence' | 'violence_against_civilians';

export interface ConflictEvent {
  id: string;
  eventType: ConflictEventType;
  subEventType: string;
  country: string;
  region?: string;
  location: string;
  lat: number;
  lon: number;
  time: Date;
  fatalities: number;
  actors: string[];
  source: string;
}

export interface ConflictData {
  events: ConflictEvent[];
  byCountry: Map<string, ConflictEvent[]>;
  totalFatalities: number;
  count: number;
}

export type ConflictIntensity = 'none' | 'minor' | 'war';

export interface UcdpConflictStatus {
  location: string;
  intensity: ConflictIntensity;
  conflictId?: number;
  conflictName?: string;
  year: number;
  typeOfConflict?: number;
  sideA?: string;
  sideB?: string;
}

export interface HapiConflictSummary {
  iso2: string;
  locationName: string;
  month: string;
  eventsTotal: number;
  eventsPoliticalViolence: number;
  eventsCivilianTargeting: number;
  eventsDemonstrations: number;
  fatalitiesTotalPoliticalViolence: number;
  fatalitiesTotalCivilianTargeting: number;
}

// ---- Adapter 1: Proto AcledConflictEvent -> legacy ConflictEvent ----

function mapProtoEventType(eventType: string): ConflictEventType {
  const lower = eventType.toLowerCase();
  if (lower.includes('battle')) return 'battle';
  if (lower.includes('explosion')) return 'explosion';
  if (lower.includes('remote violence')) return 'remote_violence';
  if (lower.includes('violence against')) return 'violence_against_civilians';
  return 'battle';
}

function toConflictEvent(proto: ProtoAcledEvent): ConflictEvent {
  return {
    id: proto.id,
    eventType: mapProtoEventType(proto.eventType),
    subEventType: '',
    country: proto.country,
    region: proto.admin1 || undefined,
    location: '',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    time: new Date(proto.occurredAt),
    fatalities: proto.fatalities,
    actors: proto.actors,
    source: proto.source,
  };
}

// ---- Adapter 3: Proto HumanitarianCountrySummary -> legacy HapiConflictSummary ----

const HAPI_COUNTRY_CODES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];

function toHapiSummary(proto: ProtoHumanSummary): HapiConflictSummary {
  // Proto fields now accurately represent HAPI conflict event data (MEDIUM-1 fix)
  return {
    iso2: proto.countryCode || '',
    locationName: proto.countryName,
    month: proto.referencePeriod || '',
    eventsTotal: proto.conflictEventsTotal || 0,
    eventsPoliticalViolence: proto.conflictPoliticalViolenceEvents || 0,
    eventsCivilianTargeting: 0, // Included in conflictPoliticalViolenceEvents
    eventsDemonstrations: proto.conflictDemonstrations || 0,
    fatalitiesTotalPoliticalViolence: proto.conflictFatalities || 0,
    fatalitiesTotalCivilianTargeting: 0, // Included in conflictFatalities
  };
}

// ---- UCDP classification derivation heuristic ----

function deriveUcdpClassifications(events: ProtoUcdpEvent[]): Map<string, UcdpConflictStatus> {
  const byCountry = new Map<string, ProtoUcdpEvent[]>();
  for (const e of events) {
    const country = e.country;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(e);
  }

  const now = Date.now();
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const result = new Map<string, UcdpConflictStatus>();

  for (const [country, countryEvents] of byCountry) {
    // Filter to trailing 2-year window
    const recentEvents = countryEvents.filter(e => (now - e.dateStart) < twoYearsMs);
    const totalDeaths = recentEvents.reduce((sum, e) => sum + e.deathsBest, 0);
    const eventCount = recentEvents.length;

    let intensity: ConflictIntensity;
    if (totalDeaths > 1000 || eventCount > 100) {
      intensity = 'war';
    } else if (eventCount > 10) {
      intensity = 'minor';
    } else {
      intensity = 'none';
    }

    // Find the highest-death event for sideA/sideB
    let maxDeathEvent: ProtoUcdpEvent | undefined;
    for (const e of recentEvents) {
      if (!maxDeathEvent || e.deathsBest > maxDeathEvent.deathsBest) {
        maxDeathEvent = e;
      }
    }

    // Most recent event year
    const mostRecentEvent = recentEvents.reduce<ProtoUcdpEvent | undefined>(
      (latest, e) => (!latest || e.dateStart > latest.dateStart) ? e : latest,
      undefined,
    );
    const year = mostRecentEvent ? new Date(mostRecentEvent.dateStart).getFullYear() : new Date().getFullYear();

    result.set(country, {
      location: country,
      intensity,
      year,
      sideA: maxDeathEvent?.sideA,
      sideB: maxDeathEvent?.sideB,
    });
  }

  return result;
}

// ---- Empty fallbacks ----

const emptyAcledFallback: ListAcledEventsResponse = { events: [], pagination: undefined };
const emptyUcdpFallback: ListUcdpEventsResponse = { events: [], pagination: undefined };
const emptyHapiFallback: GetHumanitarianSummaryResponse = { summary: undefined };
const emptyHapiBatchFallback: GetHumanitarianSummaryBatchResponse = { results: {}, fetched: 0, requested: 0 };
const hapiBatchBreaker = createCircuitBreaker<GetHumanitarianSummaryBatchResponse>({ name: 'HDX HAPI Batch', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

// ---- Exported Functions ----

export async function fetchConflictEvents(): Promise<ConflictData> {
  const resp = await acledBreaker.execute(async () => {
    return client.listAcledEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyAcledFallback, { shouldCache: (r) => r.events.length > 0 });

  const events = resp.events.map(toConflictEvent);

  const byCountry = new Map<string, ConflictEvent[]>();
  let totalFatalities = 0;

  for (const event of events) {
    totalFatalities += event.fatalities;
    const existing = byCountry.get(event.country) || [];
    existing.push(event);
    byCountry.set(event.country, existing);
  }

  return {
    events,
    byCountry,
    totalFatalities,
    count: events.length,
  };
}

export async function fetchUcdpClassifications(hydrated?: ListUcdpEventsResponse): Promise<Map<string, UcdpConflictStatus>> {
  if (hydrated?.events?.length) return deriveUcdpClassifications(hydrated.events);

  const resp = await ucdpBreaker.execute(async () => {
    return client.listUcdpEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyUcdpFallback, { shouldCache: (r) => r.events.length > 0 });

  return deriveUcdpClassifications(resp.events);
}

export async function fetchHapiSummary(): Promise<Map<string, HapiConflictSummary>> {
  const byCode = new Map<string, HapiConflictSummary>();

  const resp = await hapiBatchBreaker.execute(async () => {
    try {
      return await client.getHumanitarianSummaryBatch(
        { countryCodes: [...HAPI_COUNTRY_CODES] },
        { signal: AbortSignal.timeout(60_000) },
      );
    } catch (err: unknown) {
      // 404 deploy-skew fallback: batch endpoint not yet deployed, use per-item calls
      if (err instanceof ApiError && err.statusCode === 404) {
        const HAPI_CONCURRENT = 5;
        const allFallback: Array<{ iso2: string; r: GetHumanitarianSummaryResponse }> = [];
        for (let i = 0; i < HAPI_COUNTRY_CODES.length; i += HAPI_CONCURRENT) {
          const batch = HAPI_COUNTRY_CODES.slice(i, i + HAPI_CONCURRENT);
          const results = await Promise.allSettled(
            batch.map(async (iso2) => {
              const r = await getHapiBreaker(iso2).execute(async () => {
                return client.getHumanitarianSummary({ countryCode: iso2 });
              }, emptyHapiFallback);
              return { iso2, r };
            }),
          );
          for (const result of results) {
            if (result.status === 'fulfilled') allFallback.push(result.value);
          }
        }
        const fallbackResults: Record<string, ProtoHumanSummary> = {};
        for (const { iso2, r } of allFallback) {
          if (r.summary) fallbackResults[iso2] = r.summary;
        }
        return { results: fallbackResults, fetched: Object.keys(fallbackResults).length, requested: HAPI_COUNTRY_CODES.length };
      }
      throw err;
    }
  }, emptyHapiBatchFallback, { shouldCache: (r) => r.fetched > 0 });

  for (const [cc, summary] of Object.entries(resp.results)) {
    byCode.set(cc, toHapiSummary(summary));
  }

  return byCode;
}

export function groupByCountry(events: UcdpGeoEvent[]): Map<string, UcdpGeoEvent[]> {
  const map = new Map<string, UcdpGeoEvent[]>();
  for (const e of events) {
    const country = e.country || 'Unknown';
    if (!map.has(country)) map.set(country, []);
    map.get(country)!.push(e);
  }
  return map;
}

export function groupByType(events: UcdpGeoEvent[]): Record<string, UcdpGeoEvent[]> {
  return {
    'state-based': events.filter(e => e.type_of_violence === 'state-based'),
    'non-state': events.filter(e => e.type_of_violence === 'non-state'),
    'one-sided': events.filter(e => e.type_of_violence === 'one-sided'),
  };
}

const IRAN_RED_CATEGORIES = new Set(['military', 'airstrike', 'defense']);
const IRAN_ORANGE_CATEGORIES = new Set(['political', 'international']);

type IranColorTier = 'red' | 'orange' | 'yellow';

function iranColorTier(ev: Pick<IranEvent, 'severity' | 'category'>): IranColorTier {
  if (ev.severity === 'critical' || IRAN_RED_CATEGORIES.has(ev.category)) return 'red';
  if (IRAN_ORANGE_CATEGORIES.has(ev.category)) return 'orange';
  return 'yellow';
}

const IRAN_RGBA: Record<IranColorTier, [number, number, number, number]> = {
  red: [255, 50, 50, 220], orange: [255, 165, 0, 200], yellow: [255, 255, 0, 180],
};
const IRAN_CSS: Record<IranColorTier, string> = {
  red: 'rgba(255,50,50,0.85)', orange: 'rgba(255,165,0,0.8)', yellow: 'rgba(255,255,0,0.7)',
};

export function getIranEventColor(ev: Pick<IranEvent, 'severity' | 'category'>): [number, number, number, number] {
  return IRAN_RGBA[iranColorTier(ev)];
}

export function getIranEventCssColor(ev: Pick<IranEvent, 'severity' | 'category'>): string {
  return IRAN_CSS[iranColorTier(ev)];
}

export function getIranEventHexColor(ev: Pick<IranEvent, 'severity'>): string {
  if (ev.severity === 'high' || ev.severity === 'critical') return '#ff3030';
  if (ev.severity === 'elevated') return '#ff8800';
  return '#ffcc00';
}

export function getIranEventRadius(severity: string): number {
  if (severity === 'high' || severity === 'critical') return 20000;
  if (severity === 'elevated') return 15000;
  return 10000;
}

export function getIranEventSize(severity: string): number {
  if (severity === 'high' || severity === 'critical') return 14;
  if (severity === 'elevated') return 11;
  return 8;
}

export async function fetchIranEvents(): Promise<IranEvent[]> {
  const hydrated = getHydratedData('iranEvents') as ListIranEventsResponse | undefined;
  if (hydrated?.events?.length) return hydrated.events;

  const resp = await iranBreaker.execute(async () => {
    const cacheBust = Math.floor(Date.now() / 120_000);
    const r = await globalThis.fetch(toApiUrl(`/api/conflict/v1/list-iran-events?_v=${cacheBust}`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ListIranEventsResponse>;
  }, emptyIranFallback);
  return resp.events;
}
