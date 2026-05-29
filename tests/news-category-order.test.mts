import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { orderNewsCategoriesForLoad } from '../src/app/news-category-order.ts';

const repoRoot = resolve(import.meta.dirname, '..');

describe('orderNewsCategoriesForLoad', () => {
  it('loads cybersecurity before slower general tech categories', () => {
    const ordered = orderNewsCategoriesForLoad([
      { key: 'tech', feeds: ['tech-feed'] },
      { key: 'ai', feeds: ['ai-feed'] },
      { key: 'startups', feeds: ['startup-feed'] },
      { key: 'vcblogs', feeds: ['vc-feed'] },
      { key: 'security', feeds: ['security-feed'] },
      { key: 'policy', feeds: ['policy-feed'] },
    ]);

    assert.deepEqual(ordered.map((entry) => entry.key), [
      'security',
      'tech',
      'ai',
      'startups',
      'vcblogs',
      'policy',
    ]);
  });

  it('preserves relative order for non-priority categories', () => {
    const ordered = orderNewsCategoriesForLoad([
      { key: 'finance', feeds: [] },
      { key: 'github', feeds: [] },
      { key: 'cloud', feeds: [] },
    ]);

    assert.deepEqual(ordered.map((entry) => entry.key), ['finance', 'github', 'cloud']);
  });

  it('runs cybersecurity fallback feeds in one bounded batch', () => {
    const source = readFileSync(resolve(repoRoot, 'src/app/data-loader.ts'), 'utf8');

    assert.match(
      source,
      /batchSize:\s*category\s*===\s*'security'\s*\?\s*fallbackFeeds\.length\s*:\s*this\.perFeedFallbackBatchSize/,
    );
  });
});
