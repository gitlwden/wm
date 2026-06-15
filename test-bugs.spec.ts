import { test, expect } from '@playwright/test';

const EMAIL = 'wm_admin@1b888.us.ci';
const PASSWORD = '_QYwGmmpLR6&9k5';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('https://wm-worldmonitor-847.netlify.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  // Click Sign In
  const signInBtn = page.locator('button:has-text("Sign In"), button:has-text("Sign in")').first();
  if (await signInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signInBtn.click();
    await page.waitForTimeout(3000);
  }

  // Fill Clerk email
  const emailInput = page.locator('input[autocomplete="email"], input[name="identifier"]').first();
  if (await emailInput.isVisible({ timeout: 10000 }).catch(() => false)) {
    await emailInput.fill(EMAIL);
    await page.waitForTimeout(500);

    // Fill password
    const pwInput = page.locator('input[type="password"]').first();
    if (await pwInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pwInput.fill(PASSWORD);
      await pwInput.press('Enter');
    }
  }

  // Wait for login to complete
  await page.waitForTimeout(12000);
  console.log('Signed in, waiting for panels to load...');
  await page.waitForTimeout(8000);
}

test('Bug 1: Stock Analysis search - type ticker and verify', async ({ page }) => {
  await signIn(page);
  await page.screenshot({ path: 'test-b1-0-after-login.png' });

  // Find the stock analysis panel - should be unlocked after Pro login
  const panel = page.locator('.panel').filter({ hasText: 'Stock Analysis' }).first();
  const exists = await panel.count() > 0;
  console.log('Stock Analysis panel found:', exists);

  if (!exists) {
    await page.screenshot({ path: 'test-b1-no-panel.png' });
    throw new Error('Stock Analysis panel not found after Pro login');
  }

  // Check if panel is locked
  const isLocked = await panel.evaluate(el => el.classList.contains('panel-is-locked'));
  console.log('Panel locked:', isLocked);
  await page.screenshot({ path: 'test-b1-1-panel-state.png' });

  // Find search input inside the panel
  const searchInput = panel.locator('input').first();
  const inputCount = await panel.locator('input').count();
  console.log('Inputs in panel:', inputCount);

  if (inputCount > 0) {
    const placeholder = await searchInput.getAttribute('placeholder');
    console.log('First input placeholder:', placeholder);

    // Type a stock ticker
    await searchInput.click();
    await searchInput.fill('AAPL');
    console.log('Typed AAPL');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-b1-2-after-type.png' });

    // Check if value persisted
    const val = await searchInput.inputValue();
    console.log('Input value:', val);

    // Check for filter pills
    const pills = panel.locator('button, .watchlist-pill, [class*="pill"]');
    const pillCount = await pills.count();
    console.log('Buttons/pills in panel:', pillCount);

    // Try clicking "All" if it exists
    const allBtn = panel.locator('button:has-text("All")').first();
    if (await allBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allBtn.click();
      console.log('Clicked "All" button');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'test-b1-3-after-all.png' });
    }

    // Try clicking "profitable" if it exists
    const profBtn = panel.locator('button:has-text("profitable"), button:has-text("Profitable")').first();
    if (await profBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await profBtn.click();
      console.log('Clicked "profitable" button');
      await page.waitForTimeout(1000);
    }
  }

  await page.screenshot({ path: 'test-b1-final.png' });
});

test('Bug 2: Widget Agent - type prompt and click Send', async ({ page }) => {
  await signIn(page);

  // Open widget creator via CMD+K
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(1500);

  const cmdInput = page.locator('input[placeholder*="Search"], input[placeholder*="command"]').first();
  if (await cmdInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cmdInput.fill('widget');
    await page.waitForTimeout(1000);

    const widgetOption = page.locator(':text("Create Interactive Widget"), :text("Create interactive widget")').first();
    if (await widgetOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await widgetOption.click();
      await page.waitForTimeout(3000);
    } else {
      // Try pressing Enter to select first result
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
  }

  await page.screenshot({ path: 'test-b2-0-widget-open.png' });

  // Find the widget creator modal
  const modal = page.locator('.widget-creator-modal, .widget-chat-modal, [class*="widget-creator"], [class*="widget-chat"]').first();
  const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
  console.log('Widget modal visible:', modalVisible);

  if (!modalVisible) {
    // Try broader search
    const anyModal = page.locator('[class*="modal"]:has(textarea)').first();
    if (await anyModal.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Found modal with textarea');
    } else {
      await page.screenshot({ path: 'test-b2-no-modal.png' });
      throw new Error('Widget modal not found');
    }
  }

  // Find textarea for prompt
  const textarea = page.locator('textarea[placeholder*="Describe"], textarea[placeholder*="widget"], textarea[placeholder*="prompt"]').first();
  const taVisible = await textarea.isVisible({ timeout: 5000 }).catch(() => false);
  console.log('Textarea visible:', taVisible);

  if (taVisible) {
    await textarea.fill('Show me a chart of gold prices over the last month');
    console.log('Typed prompt');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-b2-1-typed.png' });

    // Click Send
    const sendBtn = page.locator('button:has-text("Send")').first();
    const sendVisible = await sendBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('Send button visible:', sendVisible);

    if (sendVisible) {
      // Track network errors
      const errors: string[] = [];
      page.on('response', response => {
        if (response.url().includes('widget') && response.status() >= 400) {
          errors.push(`${response.status()} ${response.url()}`);
        }
        if (response.url().includes('widget') && response.status() === 0) {
          errors.push(`NETWORK_ERROR ${response.url()}`);
        }
      });

      await sendBtn.click();
      console.log('Clicked Send');
      await page.waitForTimeout(8000);
      await page.screenshot({ path: 'test-b2-2-after-send.png' });

      // Check for error messages in the response area
      const responseArea = page.locator('.widget-response, .widget-chat-messages, [class*="response"], [class*="chat-messages"]').first();
      if (await responseArea.isVisible({ timeout: 2000 }).catch(() => false)) {
        const responseText = await responseArea.textContent();
        console.log('Response text:', responseText?.slice(0, 300));
      }

      // Check for NetworkError text anywhere in the modal
      const bodyText = await page.evaluate(() => document.body.textContent || '');
      const hasNetworkError = bodyText.includes('NetworkError') || bodyText.includes('network error');
      console.log('Has NetworkError text:', hasNetworkError);
      console.log('Network errors captured:', errors);

      if (hasNetworkError || errors.length > 0) {
        console.log('BUG CONFIRMED: NetworkError present');
      }
    }
  }
});

test('Bug 3: Panel categories count', async ({ page }) => {
  await signIn(page);

  // Open settings
  const settingsBtn = page.locator('button:has-text("Settings"), [data-action="settings"]').first();
  if (await settingsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(2000);
  }

  // Click Panels tab if needed
  const panelsTab = page.locator('button:has-text("Panels"), [data-tab="panels"]').first();
  if (await panelsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await panelsTab.click();
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: 'test-b3-panels-tab.png' });

  // Count category pills
  const catPills = page.locator('[data-panel-cat]');
  const catCount = await catPills.count();
  const labels: string[] = [];
  for (let i = 0; i < catCount; i++) {
    labels.push((await catPills.nth(i).textContent())?.trim() || '');
  }
  console.log(`Categories (${catCount}):`, labels.join(' | '));
  await page.screenshot({ path: 'test-b3-categories.png' });

  expect(catCount).toBeGreaterThanOrEqual(7);
});
