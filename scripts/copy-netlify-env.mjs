#!/usr/bin/env node
/**
 * Copy Netlify env vars from one site to another.
 * Usage: node scripts/copy-netlify-env.mjs <source-site> <target-site>
 *
 * Reads NETLIFY_AUTH_TOKEN from .env.local.
 * Copies all env vars from source to target (target values take precedence if already set).
 */

import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
const getEnv = (key) => {
  const m = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
};

const AUTH_TOKEN = getEnv('NETLIFY_AUTH_TOKEN');
if (!AUTH_TOKEN) {
  console.error('NETLIFY_AUTH_TOKEN not found in .env.local');
  process.exit(1);
}

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) {
  console.error('Usage: node scripts/copy-netlify-env.mjs <source-site> <target-site>');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };
const sites = await fetch('https://api.netlify.com/api/v1/sites', { headers }).then(r => r.json());

const findSite = (q) => sites.find(s => s.id === q || s.name === q || s.ssl_url?.includes(q));
const source = findSite(sourceArg);
const target = findSite(targetArg);

if (!source) { console.error(`Source site "${sourceArg}" not found`); process.exit(1); }
if (!target) { console.error(`Target site "${targetArg}" not found`); process.exit(1); }

console.log(`Copying env vars: ${source.name} → ${target.name}`);

// Get env vars from both sites
const [srcEnv, tgtEnv] = await Promise.all([
  fetch(`https://api.netlify.com/api/v1/sites/${source.id}/env`, { headers }).then(r => r.json()),
  fetch(`https://api.netlify.com/api/v1/sites/${target.id}/env`, { headers }).then(r => r.json()),
]);

const srcMap = Array.isArray(srcEnv)
  ? Object.fromEntries(srcEnv.map(e => [e.key, e.values?.[0]?.value]))
  : srcEnv;
const tgtKeys = new Set(Array.isArray(tgtEnv) ? tgtEnv.map(e => e.key) : Object.keys(tgtEnv));

let copied = 0;
let skipped = 0;

for (const [key, value] of Object.entries(srcMap)) {
  if (!value || tgtKeys.has(key)) {
    skipped++;
    continue;
  }
  try {
    await fetch(`https://api.netlify.com/api/v1/sites/${target.id}/env`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, values: [{ value, context: 'all' }] }),
    });
    copied++;
    console.log(`  + ${key}`);
  } catch (err) {
    console.error(`  ✗ ${key}: ${err.message}`);
  }
}

console.log(`\nDone: ${copied} copied, ${skipped} skipped (already set or empty)`);
