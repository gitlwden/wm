#!/usr/bin/env node
/**
 * Submit all wm.vercel.app URLs to IndexNow after deploy.
 * Run once after deploying the IndexNow key file:
 *   node scripts/seo-indexnow-submit.mjs
 *
 * IndexNow requires all URLs in one request to share the same host.
 * Submits separate batches per subdomain.
 */

const KEY = 'a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b';

const BATCHES = [
  {
    host: 'wm.vercel.app',
    urls: [
      'https://wm.vercel.app/',
      'https://wm.vercel.app/pro',
      'https://wm.vercel.app/blog/',
      'https://wm.vercel.app/blog/posts/what-is-worldmonitor-real-time-global-intelligence/',
      'https://wm.vercel.app/blog/posts/five-dashboards-one-platform-worldmonitor-variants/',
      'https://wm.vercel.app/blog/posts/track-global-conflicts-in-real-time/',
      'https://wm.vercel.app/blog/posts/cyber-threat-intelligence-for-security-teams/',
      'https://wm.vercel.app/blog/posts/osint-for-everyone-open-source-intelligence-democratized/',
      'https://wm.vercel.app/blog/posts/natural-disaster-monitoring-earthquakes-fires-volcanoes/',
      'https://wm.vercel.app/blog/posts/real-time-market-intelligence-for-traders-and-analysts/',
      'https://wm.vercel.app/blog/posts/monitor-global-supply-chains-and-commodity-disruptions/',
      'https://wm.vercel.app/blog/posts/satellite-imagery-orbital-surveillance/',
      'https://wm.vercel.app/blog/posts/live-webcams-from-geopolitical-hotspots/',
      'https://wm.vercel.app/blog/posts/prediction-markets-ai-forecasting-geopolitics/',
      'https://wm.vercel.app/blog/posts/command-palette-search-everything-instantly/',
      'https://wm.vercel.app/blog/posts/worldmonitor-in-21-languages-global-intelligence-for-everyone/',
      'https://wm.vercel.app/blog/posts/ai-powered-intelligence-without-the-cloud/',
      'https://wm.vercel.app/blog/posts/build-on-worldmonitor-developer-api-open-source/',
      'https://wm.vercel.app/blog/posts/worldmonitor-vs-traditional-intelligence-tools/',
      'https://wm.vercel.app/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/',
    ],
  },
  { host: 'tech.wm.vercel.app', urls: ['https://tech.wm.vercel.app/'] },
  { host: 'finance.wm.vercel.app', urls: ['https://finance.wm.vercel.app/'] },
  { host: 'happy.wm.vercel.app', urls: ['https://happy.wm.vercel.app/'] },
];

const ENDPOINTS = [
  'https://api.indexnow.org/IndexNow',
  'https://www.bing.com/IndexNow',
  'https://searchadvisor.naver.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://yandex.com/indexnow',
];

async function submit(endpoint, host, urlList) {
  const keyLocation = `https://${host}/${KEY}.txt`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key: KEY, keyLocation, urlList }),
  });
  return { endpoint, host, status: res.status, ok: res.ok };
}

for (const { host, urls } of BATCHES) {
  console.log(`\n[${host}] (${urls.length} URLs)`);
  const results = await Promise.allSettled(ENDPOINTS.map(ep => submit(ep, host, urls)));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`  ${r.value.ok ? '✓' : '✗'} ${r.value.endpoint.replace('https://', '')} → ${r.value.status}`);
    } else {
      console.log(`  ✗ error: ${r.reason}`);
    }
  }
}
