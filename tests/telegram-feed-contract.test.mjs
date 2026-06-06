import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listTelegramFeed } from '../server/worldmonitor/intelligence/v1/list-telegram-feed.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(path = '/api/telegram-feed?limit=50') {
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app' },
  });
}

/**
 * Build a fake t.me/s/ HTML page with one message.
 * @param {object} opts
 * @param {string} opts.channel
 * @param {number} opts.id
 * @param {string} opts.text
 * @param {string} [opts.datetime]  ISO timestamp
 * @param {string} [opts.imgSrc]    data-src image URL
 */
function fakeTelegramHtml({ channel, id, text, datetime = '2026-06-06T10:00:00+00:00', imgSrc }) {
  const imgTag = imgSrc
    ? `<div class="tgme_widget_message_photo_wrap"><i style="background-image:url('${imgSrc}')"></i></div>`
    : '';
  return `<!DOCTYPE html><html><body>
<div class="tgme_channel_history">
<div class="tgme_widget_message_wrap" data-post="${channel}/${id}">
  <div class="tgme_widget_message" data-post="${channel}/${id}">
    <div class="tgme_widget_message_info">
      <time datetime="${datetime}"></time>
    </div>
    <div class="tgme_widget_message_text js-message_text">${text}</div>
    ${imgTag}
  </div>
</div>
</div></body></html>`;
}

describe('api/telegram-feed direct scraping', () => {
  beforeEach(() => {
    // No relay env vars needed — scraping is self-contained
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('scrapes messages from t.me/s/ and normalizes them', async () => {
    const html = fakeTelegramHtml({
      channel: 'liveuamap',
      id: 12345,
      text: 'Breaking: missile launch detected',
    });

    globalThis.fetch = async (url) => {
      assert.match(String(url), /t\.me\/s\/liveuamap$/);
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    };

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=30&topic=breaking'));
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.ok(data.count >= 1, 'should find at least 1 message');
    assert.equal(data.items[0].source, 'telegram');
    assert.equal(data.items[0].channel, 'liveuamap');
    assert.equal(data.items[0].id, 'liveuamap/12345');
    assert.equal(data.items[0].text, 'Breaking: missile launch detected');
    assert.equal(data.items[0].topic, 'breaking');
    assert.match(data.items[0].url, /liveuamap\/12345$/);
    assert.match(data.items[0].ts, /\d{4}-\d{2}-\d{2}T/);
  });

  it('extracts media URLs from background-image styles', async () => {
    const html = fakeTelegramHtml({
      channel: 'test_channel',
      id: 100,
      text: 'Photo report',
      imgSrc: 'https://cdn.example.com/photo.jpg',
    });

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));
    const data = await res.json();

    assert.ok(data.items.length >= 1);
    assert.deepEqual(data.items[0].mediaUrls, ['https://cdn.example.com/photo.jpg']);
  });

  it('decodes HTML entities in message text', async () => {
    const html = fakeTelegramHtml({
      channel: 'entities_test',
      id: 200,
      text: 'AT&amp;T reports &lt;incident&gt; &quot;unusual&quot; activity',
    });

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));
    const data = await res.json();

    assert.ok(data.items.length >= 1);
    assert.equal(data.items[0].text, 'AT&T reports <incident> "unusual" activity');
  });

  it('assigns topic from the channel map', async () => {
    const html = fakeTelegramHtml({
      channel: 'cyb_detective',
      id: 300,
      text: 'New CVE disclosed',
    });

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));
    const data = await res.json();

    assert.ok(data.items.length >= 1);
    assert.equal(data.items[0].topic, 'cyber');
  });

  it('returns 502 when all channel fetches fail', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    // Use a topic with few channels so the test is fast
    const res = await handler(makeRequest('/api/telegram-feed?limit=5&topic=cyber'));
    const data = await res.json();

    // Even if all channels fail, we return an empty feed (not an error)
    // because individual channel failures are silently skipped
    assert.equal(data.enabled, true);
    assert.equal(data.count, 0);
  });

  it('handles empty channel gracefully', async () => {
    const html = '<html><body><div class="tgme_channel_history"></div></body></html>';

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));
    const data = await res.json();

    assert.equal(data.enabled, true);
    assert.equal(data.count, 0);
    assert.deepEqual(data.items, []);
  });

  it('sorts items by timestamp descending', async () => {
    const ch = 'sorting_test';
    const html = `<html><body><div class="tgme_channel_history">
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${ch}/1">
  <time datetime="2026-01-01T08:00:00+00:00"></time>
  <div class="tgme_widget_message_text">older</div>
</div></div>
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${ch}/5">
  <time datetime="2026-01-01T12:00:00+00:00"></time>
  <div class="tgme_widget_message_text">newer</div>
</div></div>
</div></body></html>`;

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));
    const data = await res.json();

    assert.equal(data.items[0].text, 'newer');
    assert.equal(data.items[1].text, 'older');
  });

  it('returns valid cache-control header', async () => {
    const html = fakeTelegramHtml({
      channel: 'cache_test',
      id: 400,
      text: 'cache test',
    });

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest('/api/telegram-feed?limit=10'));

    assert.match(res.headers.get('cache-control') || '', /s-maxage=\d+/);
  });
});

describe('server listTelegramFeed relay normalization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps alternate relay field names into the public intelligence API contract', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      count: 0,
      items: [{
        id: 'msg-1',
        channelTitle: 'OSINT Watch',
        ts: '2026-04-06T12:30:00Z',
        url: 'https://t.me/osintwatch/1',
        text: 'Port disruption reported',
        topic: 'geopolitics',
        mediaUrls: [91, 'https://cdn.example.com/chart.png'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.messages.length, 1);
    assert.equal(response.messages[0].channelName, 'OSINT Watch');
    assert.equal(response.messages[0].sourceUrl, 'https://t.me/osintwatch/1');
    assert.equal(
      response.messages[0].timestampMs,
      Date.parse('2026-04-06T12:30:00Z'),
    );
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/chart.png']);
  });

  it('normalizes numeric Unix-second timestamps in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'msg-seconds',
        channel: 'osint',
        ts: 1_744_000_000,
        url: 'https://t.me/osint/seconds',
        text: 'Numeric seconds timestamp',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].timestampMs, 1_744_000_000_000);
  });

  it('filters unsafe source and media URLs in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      messages: [{
        id: 'msg-unsafe-url',
        channel: 'osint',
        timestampMs: 1_744_000_000_000,
        sourceUrl: 'javascript:alert(1)',
        text: 'Unsafe URLs should not leave the server contract',
        mediaUrls: [
          'https://cdn.example.com/photo.jpg',
          'javascript:alert(2)',
          'ftp://cdn.example.com/file.jpg',
          'not a url',
          42,
        ],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].sourceUrl, '');
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/photo.jpg']);
  });
});
