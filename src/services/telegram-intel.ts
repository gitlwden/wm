import { proxyUrl } from '@/utils';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

export interface TelegramItem {
  id: string;
  source: 'telegram';
  channel: string;
  channelTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
  mediaUrls?: string[];
}

export interface TelegramFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: TelegramItem[];
}

export const TELEGRAM_TOPICS = [
  { id: 'all', labelKey: 'components.telegramIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.telegramIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.telegramIntel.filterConflict' },
  { id: 'geopolitics', labelKey: 'components.telegramIntel.filterGeopolitics' },
  { id: 'middleeast', labelKey: 'components.telegramIntel.filterMiddleeast' },
  { id: 'osint', labelKey: 'components.telegramIntel.filterOsint' },
  { id: 'cyber', labelKey: 'components.telegramIntel.filterCyber' },
] as const;

const cache = new Map<string, { response: TelegramFeedResponse; at: number }>();
const CACHE_TTL = 30_000;
const EMPTY_CACHE_TTL = 10_000;
const MISSING_TIMESTAMP_ISO = new Date(0).toISOString();

function telegramFeedUrl(limit: number, topic?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (topic) params.set('topic', topic);
  const path = `/api/telegram-feed?${params}`;
  return isDesktopRuntime() ? proxyUrl(path) : toApiUrl(path);
}

export async function fetchTelegramFeed(limit = 50, topic?: string): Promise<TelegramFeedResponse> {
  const key = `${limit}:${topic || 'all'}`;
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.response.count === 0 ? EMPTY_CACHE_TTL : CACHE_TTL;
    if (Date.now() - cached.at < ttl) return cached.response;
  }

  const res = await fetch(telegramFeedUrl(limit, topic));
  if (!res.ok) throw new Error(`Telegram feed ${res.status}`);

  const json: TelegramFeedResponse = await res.json();
  cache.set(key, { response: json, at: Date.now() });
  return json;
}

export function formatTelegramTime(ts: string): string {
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time) || ts === MISSING_TIMESTAMP_ISO) return 'unknown';

  const diff = Date.now() - time;
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
