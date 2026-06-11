import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
const getEnv = (key) => {
  const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : '';
};

const EMAIL = getEnv('TEST_USER_EMAIL');
const PASSWORD = getEnv('TEST_USER_PASSWORD');
const BASE = 'https://wm-worldmonitor.netlify.app';

console.log(`Testing with: ${EMAIL}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();

try {
  // 1. Open site
  console.log('1. Opening site...');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 2. Set finance variant via localStorage and reload
  console.log('2. Setting finance variant...');
  await page.evaluate(() => {
    localStorage.setItem('worldmonitor-variant', 'finance');
  });
  await page.goto(`${BASE}/?variant=finance`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 3. Sign in via Clerk
  console.log('3. Signing in via Clerk...');

  // Click sign-in button in header
  const signInBtn = page.locator('button:has-text("Sign In"), .auth-sign-in-btn, [data-cl-signin]').first();
  if (await signInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signInBtn.click();
    console.log('   Clicked Sign In button');
  } else {
    // Try the auth widget / user button
    const authWidget = page.locator('.auth-header-widget button, .clerk-header button, button:has-text("Sign")').first();
    if (await authWidget.isVisible({ timeout: 3000 }).catch(() => false)) {
      await authWidget.click();
      console.log('   Clicked auth widget');
    }
  }

  await page.waitForTimeout(3000);

  // Clerk modal: enter email
  const emailInput = page.locator('input[name="identifier"], input[id*="identifier"], input[type="email"]').first();
  if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    console.log('   Found email input');
    await emailInput.fill(EMAIL);
    await page.waitForTimeout(500);

    // Click the Continue button (Clerk uses a button with text "Continue")
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await continueBtn.click();
      console.log('   Clicked Continue button');
    } else {
      await emailInput.press('Enter');
      console.log('   Pressed Enter');
    }
    await page.waitForTimeout(4000);

    // Enter password
    const passwordInput = page.locator('input[name="password"], input[type="password"], input[id*="password"]').first();
    if (await passwordInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      console.log('   Found password input');
      await passwordInput.fill(PASSWORD);
      await page.waitForTimeout(500);

      // Click Sign in button
      const signInSubmit = page.locator('button:has-text("Sign in"), button:has-text("Continue")').first();
      if (await signInSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
        await signInSubmit.click();
        console.log('   Clicked Sign in button');
      } else {
        await passwordInput.press('Enter');
        console.log('   Pressed Enter for password');
      }
      await page.waitForTimeout(8000);
    } else {
      console.log('   Password input NOT found - taking debug screenshot');
      await page.screenshot({ path: 'e2e/screenshots/debug-no-password.png', fullPage: false });
    }
  } else {
    console.log('   Email input NOT found - checking if already signed in...');
  }

  // 4. Check auth state
  const isSignedIn = await page.evaluate(() => {
    return document.querySelector('.cl-userButton') !== null;
  });
  console.log(`4. Signed in: ${isSignedIn}`);

  await page.screenshot({ path: 'e2e/screenshots/after-login.png', fullPage: false });

  // 5. Find and check Pro panels
  console.log('5. Checking Pro panels...');

  // Scroll through the page to find panels
  for (const panelId of ['stock-analysis', 'stock-backtest']) {
    const panel = page.locator(`[data-panel="${panelId}"]`).first();
    const visible = await panel.isVisible({ timeout: 5000 }).catch(() => false);

    if (visible) {
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(2000);

      const isLocked = await panel.locator('.panel-is-locked, .panel-locked-state').first()
        .isVisible({ timeout: 2000 }).catch(() => false);

      const hasContent = await panel.locator('.panel-content-body, .panel-body, canvas, table, .chart-container').first()
        .isVisible({ timeout: 2000 }).catch(() => false);

      const lockedText = await panel.locator('.panel-locked-desc, .panel-locked-cta').first()
        .textContent().catch(() => '');

      console.log(`   ${panelId}: visible=${visible}, locked=${isLocked}, hasContent=${hasContent}, lockText="${lockedText}"`);
    } else {
      console.log(`   ${panelId}: NOT VISIBLE`);
    }
  }

  await page.screenshot({ path: 'e2e/screenshots/pro-panels.png', fullPage: false });
  console.log('\nScreenshots saved to e2e/screenshots/');

} catch (err) {
  console.error('Error:', err.message);
  await page.screenshot({ path: 'e2e/screenshots/error.png', fullPage: false });
} finally {
  await browser.close();
}
