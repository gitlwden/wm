import { getHydratedData } from '@/services/bootstrap';

export interface ServerInsightStory {
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  pubDate: string;
  sourceCount: number;
  importanceScore: number;
  velocity: { level: string; sourcesPerHour: number };
  isAlert: boolean;
  category: string;
  threatLevel: string;
  countryCode: string | null;
}

export interface ServerInsights {
  worldBrief: string;
  briefProvider: string;
  status: 'ok' | 'degraded';
  topStories: ServerInsightStory[];
  generatedAt: string | number;
  clusterCount: number;
  multiSourceCount: number;
  fastMovingCount: number;
}

let cached: ServerInsights | null = null;
const HYDRATED_INSIGHTS_KEYS = ['insights', 'newsInsights', 'worldBrief', 'dailyMarketBrief', 'daily-market-brief', 'news:insights:v1'];
// Server cron interval: scripts/seed-insights.mjs runs every 30 min
// (CACHE_TTL=10800s/3h). Keep the client freshness gate aligned to the
// server-side cache TTL so a brief does not disappear between workflow runs
// or during a single missed cron tick. The panel should degrade/stale later,
// not render blank while Redis still has a valid hydrated snapshot.
// Exported so the regression test asserts against the real value rather than
// inlining a copy that drifts silently when this constant changes.
export const MAX_AGE_MS = 3 * 60 * 60 * 1000;

function normalizeGeneratedAtMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeGeneratedAtValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function isFresh(data: ServerInsights): boolean {
  const generatedAtMs = normalizeGeneratedAtMs(data.generatedAt);
  if (!generatedAtMs) return false;
  return Date.now() - generatedAtMs < MAX_AGE_MS;
}

function unwrapHydratedInsights(raw: unknown): { payload: unknown; seedFetchedAt: unknown } {
  if (typeof raw === 'string') {
    try {
      return unwrapHydratedInsights(JSON.parse(raw));
    } catch {
      return { payload: raw, seedFetchedAt: null };
    }
  }
  if (!raw || typeof raw !== 'object') return { payload: raw, seedFetchedAt: null };
  const outer = raw as Record<string, unknown>;
  const seed = outer._seed && typeof outer._seed === 'object'
    ? outer._seed as Record<string, unknown>
    : null;
  if ('data' in outer && (seed || outer.data == null || typeof outer.data === 'object')) {
    return { payload: outer.data, seedFetchedAt: seed?.fetchedAt ?? null };
  }
  return { payload: raw, seedFetchedAt: null };
}

function normalizeInsightStory(raw: unknown): ServerInsightStory | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const primaryTitle = String(item.primaryTitle || item.title || item.headline || '').trim();
  if (!primaryTitle) return null;
  return {
    primaryTitle,
    primarySource: String(item.primarySource || item.source || '').trim(),
    primaryLink: String(item.primaryLink || item.link || '').trim(),
    pubDate: String(item.pubDate || item.publishedAt || item.date || '').trim(),
    sourceCount: typeof item.sourceCount === 'number' ? item.sourceCount : 1,
    importanceScore: typeof item.importanceScore === 'number' ? item.importanceScore : 0,
    velocity: item.velocity && typeof item.velocity === 'object'
      ? item.velocity as { level: string; sourcesPerHour: number }
      : { level: 'normal', sourcesPerHour: 0 },
    isAlert: Boolean(item.isAlert),
    category: String(item.category || '').trim(),
    threatLevel: String(item.threatLevel || '').trim(),
    countryCode: typeof item.countryCode === 'string' ? item.countryCode : null,
  };
}

function normalizeServerInsights(raw: unknown): ServerInsights | null {
  const unwrapped = unwrapHydratedInsights(raw);
  if (!unwrapped.payload || typeof unwrapped.payload !== 'object') return null;
  const payload = unwrapped.payload as Record<string, unknown>;
  const nested = !payload.worldBrief && !payload.brief && !payload.summary && !payload.topStories && !payload.stories
    ? (payload.insights || payload.newsInsights || payload.worldBriefData)
    : null;
  const data = nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : payload;
  const payloadGeneratedAt = data.generatedAt || data.fetchedAt;
  const payloadGeneratedAtMs = normalizeGeneratedAtMs(payloadGeneratedAt);
  const seedFetchedAtMs = normalizeGeneratedAtMs(unwrapped.seedFetchedAt);
  const generatedAt = seedFetchedAtMs && (!payloadGeneratedAtMs || Date.now() - payloadGeneratedAtMs >= MAX_AGE_MS)
    ? normalizeGeneratedAtValue(unwrapped.seedFetchedAt) ?? Date.now()
    : normalizeGeneratedAtValue(payloadGeneratedAt) ?? normalizeGeneratedAtValue(unwrapped.seedFetchedAt) ?? Date.now();
  const worldBrief = String(data.worldBrief || data.brief || data.summary || '').trim();
  const rawStories = Array.isArray(data.topStories)
    ? data.topStories
    : Array.isArray(data.stories)
      ? data.stories
      : [];
  const topStories = rawStories.map(normalizeInsightStory).filter((story): story is ServerInsightStory => story !== null);
  if (!worldBrief && topStories.length === 0) return null;

  return {
    worldBrief,
    briefProvider: String(data.briefProvider || data.provider || '').trim(),
    status: data.status === 'degraded' ? 'degraded' : 'ok',
    topStories,
    generatedAt,
    clusterCount: typeof data.clusterCount === 'number' ? data.clusterCount : topStories.length,
    multiSourceCount: typeof data.multiSourceCount === 'number' ? data.multiSourceCount : 0,
    fastMovingCount: typeof data.fastMovingCount === 'number' ? data.fastMovingCount : topStories.filter(story => story.isAlert).length,
  };
}

function readHydratedInsights(): unknown {
  for (const key of HYDRATED_INSIGHTS_KEYS) {
    const value = getHydratedData(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function getServerInsights(): ServerInsights | null {
  if (cached && isFresh(cached)) {
    return cached;
  }
  cached = null;

  const data = normalizeServerInsights(readHydratedInsights());
  if (!data || !isFresh(data)) return null;

  cached = data;
  return data;
}

export function setServerInsights(data: ServerInsights): void {
  cached = normalizeServerInsights(data);
}
