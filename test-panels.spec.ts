import { test, expect } from '@playwright/test';

test('Panel health check', async ({ page }) => {
  await page.goto('https://wm-worldmonitor-847.netlify.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(20000);

  // Get panel containers by data-panel-id
  const panelStates = await page.evaluate(() => {
    const results: Record<string, string> = {};
    // Panel containers have data-panel-id or are .panel elements with IDs
    document.querySelectorAll('[data-panel]').forEach(el => {
      const id = el.getAttribute('data-panel')!;
      const text = (el.textContent || '').trim();
      const hasError = el.querySelector('.panel-error-state, .panel-loading.panel-error-radar') !== null;
      const hasLoading = el.querySelector('.panel-loading:not(.panel-loading-radar)') !== null;
      const isEmpty = /no data|unavailable|No items|all sources disabled/i.test(text) && text.length < 200;
      const isLocked = el.querySelector('.panel-locked-state') !== null;
      results[id] = isLocked ? 'LOCKED' : hasError ? 'ERROR' : hasLoading ? 'LOADING' : isEmpty ? 'EMPTY' : 'OK';
    });
    return results;
  });

  const sorted = Object.entries(panelStates).sort(([a], [b]) => a.localeCompare(b));
  console.log(`\n${sorted.length} panels found:\n`);
  for (const [id, state] of sorted) {
    const icon = { OK: '✅', EMPTY: '⚠️', LOADING: '🔄', ERROR: '❌', LOCKED: '🔒' }[state] || '?';
    console.log(`  ${icon} ${id}: ${state}`);
  }

  const summary = { OK: 0, EMPTY: 0, LOADING: 0, ERROR: 0, LOCKED: 0 };
  for (const [, s] of sorted) (summary as Record<string, number>)[s]++;

  console.log(`\n✅ OK: ${summary.OK}  ⚠️ EMPTY: ${summary.EMPTY}  🔄 LOADING: ${summary.LOADING}  ❌ ERROR: ${summary.ERROR}  🔒 LOCKED: ${summary.LOCKED}`);

  await page.screenshot({ path: 'test-panels-overview.png' });

  // Allow EMPTY (data source issues) but no ERROR states
  expect(summary.ERROR).toBe(0);
});
