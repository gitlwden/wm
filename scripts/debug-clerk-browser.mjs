import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const events = [];

page.on('console', (msg) => {
  const text = msg.text();
  if (/clerk|content security policy|refused|error|warning|auth/i.test(text)) {
    events.push({ type: 'console', level: msg.type(), text });
  }
});

page.on('pageerror', (err) => {
  events.push({ type: 'pageerror', text: err.stack || err.message });
});

page.on('requestfailed', (request) => {
  const requestUrl = request.url();
  if (/clerk|accounts\.dev|captcha|auth|npm|vite/i.test(requestUrl)) {
    events.push({
      type: 'requestfailed',
      url: requestUrl,
      failure: request.failure()?.errorText ?? '',
    });
  }
});

page.on('response', (response) => {
  const responseUrl = response.url();
  if (/clerk|accounts\.dev|captcha|auth/i.test(responseUrl) && response.status() >= 400) {
    events.push({ type: 'badresponse', status: response.status(), url: responseUrl });
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(1500);

const signIn = page.getByRole('button', { name: /^Sign In$/i }).first();
await signIn.waitFor({ state: 'visible', timeout: 30_000 });
await signIn.click();
await page.waitForTimeout(8000);

const modalCount = await page.locator('.cl-modalBackdrop, .cl-modalContent, [data-clerk-modal-root], iframe[src*="clerk"], iframe[src*="accounts.dev"]').count();
const htmlProbe = await page.evaluate(() => {
  const text = document.body.innerText.slice(0, 1200);
  const clerkNodes = [...document.querySelectorAll('[class*="cl-"], [data-clerk-modal-root], iframe')]
    .slice(0, 20)
    .map((el) => ({
      tag: el.tagName,
      className: el.getAttribute('class'),
      data: el.getAttribute('data-clerk-modal-root'),
      src: el.getAttribute('src'),
      text: (el.textContent || '').slice(0, 120),
    }));
  return { text, clerkNodes };
});

await page.screenshot({ path: 'test-results/clerk-signin-debug.png', fullPage: true });
console.log(JSON.stringify({ modalCount, htmlProbe, events }, null, 2));
await browser.close();
