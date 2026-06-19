import { fetchLatestRelease } from './_github-release.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

// Fallback version from package.json (bundled at build time)
const PKG_VERSION = '2.8.0';

export default async function handler() {
  try {
    const release = await fetchLatestRelease('WorldMonitor-Version-Check');
    if (release) {
      const tag = release.tag_name ?? '';
      const version = tag.replace(/^v/, '');
      return jsonResponse({
        version,
        tag,
        url: release.html_url,
        prerelease: release.prerelease ?? false,
      }, 200, {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=3600',
        'Access-Control-Allow-Origin': '*',
      });
    }

    // No GitHub release — fall back to package.json version
    return jsonResponse({
      version: PKG_VERSION,
      tag: `v${PKG_VERSION}`,
      url: '',
      prerelease: false,
    }, 200, {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=3600',
      'Access-Control-Allow-Origin': '*',
    });
  } catch {
    return jsonResponse({ error: 'fetch_failed' }, 502);
  }
}
