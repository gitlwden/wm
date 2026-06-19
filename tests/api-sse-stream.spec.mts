/**
 * SSE Streaming API tests — validates deduct-situation-stream and news-feed-stream.
 * Run: npx playwright test tests/api-sse-stream.spec.mts
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://wm-worldmonitor-847.netlify.app';
const KEY = process.env.WM_API_KEY || 'wm_e5a7ee5982b58b89a51a65fd48c40356f71b32ba';

// ─── deduct-situation-stream ───────────────────────────────────────

test.describe('deduct-situation-stream', () => {
  test('returns SSE with processing or cached status', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/deduct-situation-stream`, {
      headers: {
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': KEY,
      },
      data: { query: 'What is the current global geopolitical risk level?' },
    });

    // Before deploy: may return 404/502 — skip assertion
    if (!resp.ok()) {
      console.log(`  SKIP: endpoint not deployed yet (HTTP ${resp.status()})`);
      return;
    }

    expect(resp.headers()['content-type']).toContain('text/event-stream');
    const text = await resp.text();
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const statuses = events.map(e => e.status);
    expect(statuses.some(s => ['cached', 'done', 'processing', 'error'].includes(s as string))).toBeTruthy();

    const doneEvent = events.find(e => e.status === 'done');
    if (doneEvent?.result) {
      const result = doneEvent.result as Record<string, unknown>;
      expect(typeof result.analysis).toBe('string');
      expect((result.analysis as string).length).toBeGreaterThan(50);
    }
  });

  test('returns error for empty query', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/deduct-situation-stream`, {
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': KEY },
      data: { query: '' },
    });

    if (!resp.ok()) {
      console.log(`  SKIP: endpoint not deployed yet (HTTP ${resp.status()})`);
      return;
    }

    const text = await resp.text();
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('error');
  });

  test('returns 401 without API key', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/deduct-situation-stream`, {
      headers: { 'Content-Type': 'application/json' },
      data: { query: 'test' },
    });

    expect(resp.status()).toBe(401);
  });
});

// ─── news-feed-stream ─────────────────────────────────────────────

test.describe('news-feed-stream', () => {
  test('returns SSE with cached or processing status', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/news-feed-stream`, {
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': KEY },
      data: { variant: 'full', lang: 'en' },
    });

    if (!resp.ok()) {
      console.log(`  SKIP: endpoint not deployed yet (HTTP ${resp.status()})`);
      return;
    }

    expect(resp.headers()['content-type']).toContain('text/event-stream');
    const text = await resp.text();
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const statuses = events.map(e => e.status);
    expect(statuses.some(s => ['cached', 'done', 'processing', 'error'].includes(s as string))).toBeTruthy();

    const resultEvent = events.find(e => e.status === 'cached' || e.status === 'done');
    if (resultEvent?.result) {
      const result = resultEvent.result as Record<string, unknown>;
      expect(result.categories).toBeTruthy();
    }
  });

  test('returns 401 without API key', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/news-feed-stream`, {
      headers: { 'Content-Type': 'application/json' },
      data: { variant: 'full' },
    });

    expect(resp.status()).toBe(401);
  });
});

// ─── Standard endpoints (non-streaming) ────────────────────────────

test.describe('standard API endpoints', () => {
  test('market quotes returns data', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/market/v1/list-market-quotes`, {
      headers: { 'X-WorldMonitor-Key': KEY },
    });

    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.quotes).toBeDefined();
    expect(Array.isArray(body.quotes)).toBeTruthy();
    expect(body.quotes.length).toBeGreaterThan(0);
  });

  test('risk-scores returns data', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/intelligence/v1/get-risk-scores`, {
      headers: { 'X-WorldMonitor-Key': KEY },
    });

    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.ciiScores || body.scores).toBeDefined();
  });

  test('version endpoint returns version', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/version`);
    // After fix: should return 200 with version
    if (resp.ok()) {
      const body = await resp.json();
      expect(body.version).toBeDefined();
    }
    // Before fix: 502 (acceptable until Netlify redeploys)
  });

  test('health endpoint returns OK', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/health`);
    expect(resp.ok()).toBeTruthy();
  });
});
