/**
 * Fetches GitHub repository metadata (stars, last push date) via the RSS proxy.
 * Used to enrich GitHub category news items with repo-level context.
 */
import type { NewsItem } from '@/types';
import { fetchWithProxy } from '@/utils/proxy';

/** Matches github.com/owner/repo URLs (excludes sub-paths like /issues, /pull/123). */
const GITHUB_REPO_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:[/?#]|$)/;

/** Extracts "owner/repo" from a GitHub URL, or null if not a repo link. */
export function extractRepoFromUrl(url: string): string | null {
  const m = url.match(GITHUB_REPO_PATTERN);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface RepoMeta {
  stars: number;
  pushedAt: string;
}

/** In-memory cache keyed by "owner/repo". Survives for the SPA session lifetime. */
const metaCache = new Map<string, RepoMeta>();

/** Concurrency limit for GitHub API calls. */
const CONCURRENCY = 5;

/**
 * Fetches a single repo's metadata from GitHub's public REST API (via proxy).
 * Results are cached in-memory for the session.
 */
export async function fetchGitHubRepoMeta(repoFullName: string): Promise<RepoMeta | null> {
  const cached = metaCache.get(repoFullName);
  if (cached) return cached;

  try {
    const resp = await fetchWithProxy(`https://api.github.com/repos/${repoFullName}`);
    if (!resp.ok) return null;
    const data = await resp.json() as {
      stargazers_count?: number;
      pushed_at?: string;
    };
    const meta: RepoMeta = {
      stars: data.stargazers_count ?? 0,
      pushedAt: data.pushed_at ?? '',
    };
    metaCache.set(repoFullName, meta);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Enriches an array of NewsItem with GitHub repo metadata.
 * Only items whose `link` is a github.com/owner/repo URL are enriched.
 * Deduplicates repos and fetches in parallel batches of CONCURRENCY.
 */
export async function enrichItemsWithGithubMeta(items: NewsItem[]): Promise<void> {
  const repoItems: { item: NewsItem; repo: string }[] = [];

  for (const item of items) {
    const repo = extractRepoFromUrl(item.link);
    if (repo) repoItems.push({ item, repo });
  }

  if (repoItems.length === 0) return;

  // Deduplicate repos to minimize API calls
  const uniqueRepos = [...new Set(repoItems.map(r => r.repo))];

  // Fetch metadata in parallel batches
  const metaMap = new Map<string, RepoMeta>();

  for (let i = 0; i < uniqueRepos.length; i += CONCURRENCY) {
    const batch = uniqueRepos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (repo) => {
        const meta = await fetchGitHubRepoMeta(repo);
        return { repo, meta };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.meta) {
        metaMap.set(r.value.repo, r.value.meta);
      }
    }
  }

  // Attach metadata to items
  for (const { item, repo } of repoItems) {
    const meta = metaMap.get(repo);
    if (meta) {
      item.githubMeta = meta;
    }
  }
}

/**
 * Formats a star count for compact display.
 * e.g. 1234 → "1.2k", 12345 → "12.3k", 500 → "500"
 */
export function formatStarCount(stars: number): string {
  if (stars >= 1_000_000) return `${(stars / 1_000_000).toFixed(1)}m`;
  if (stars >= 1_000) return `${(stars / 1_000).toFixed(1)}k`;
  return String(stars);
}

/**
 * Formats an ISO date string as a relative "time ago" label.
 * e.g. "2d ago", "3h ago", "5mo ago"
 */
export function formatRelativeDate(isoDate: string): string {
  if (!isoDate) return '';
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return '';

  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
