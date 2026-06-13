import { test, expect } from '@playwright/test';

test('All major panels load without errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 150));
  });

  await page.goto('https://wm-worldmonitor-847.netlify.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(20000); // wait for panels to load

  // Get all panel states
  const panelStates = await page.evaluate(() => {
    const panels = document.querySelectorAll('[class*="panel"]');
    const results: Record<string, string> = {};
    for (const p of panels) {
      const id = (p as HTMLElement).dataset?.panelId || p.className.match(/panel-(\w[\w-]*)/)?.[1] || '';
      if (!id) continue;
      const text = (p.textContent || '').trim().slice(0, 100);
      const hasError = p.querySelector('.panel-error, .error') !== null;
      const hasLoading = p.querySelector('.panel-loading, .loading') !== null;
      const isEmpty = text.includes('No data') || text.includes('unavailable') || text.includes('No items');
      const state = hasError ? 'ERROR' : hasLoading ? 'LOADING' : isEmpty ? 'EMPTY' : 'OK';
      results[id] = state;
    }
    return results;
  });

  console.log('Panel states:');
  for (const [id, state] of Object.entries(panelStates).sort()) {
    const icon = state === 'OK' ? '✅' : state === 'EMPTY' ? '⚠️' : state === 'LOADING' ? '🔄' : '❌';
    console.log(`  ${icon} ${id}: ${state}`);
  }

  const errors = Object.entries(panelStates).filter(([, s]) => s === 'ERROR');
  const empty = Object.entries(panelStates).filter(([, s]) => s === 'EMPTY');
  const loading = Object.entries(panelStates).filter(([, s]) => s === 'LOADING');

  console.log(`\nTotal: ${Object.keys(panelStates).length} panels`);
  console.log(`  OK: ${Object.keys(panelStates).length - errors.length - empty.length - loading.length}`);
  console.log(`  EMPTY: ${empty.length} — ${empty.map(([id]) => id).join(', ')}`);
  console.log(`  LOADING: ${loading.length} — ${loading.map(([id]) => id).join(', ')}`);
  console.log(`  ERROR: ${errors.length} — ${errors.map(([id]) => id).join(', ')}`);
  console.log(`\nConsole errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 5).forEach(e => console.log(`  ${e}`));

  await page.screenshot({ path: 'test-panels-overview.png', fullPage: false });

  // No panels should be in ERROR state
  expect(errors.length).toBe(0);
});
