#!/usr/bin/env node
/**
 * Switch Netlify deployment target.
 * Usage: node scripts/switch-netlify-site.mjs <site-name-or-id>
 *   e.g. node scripts/switch-netlify-site.mjs wm-worldmonitor-847
 *
 * Reads NETLIFY_AUTH_TOKEN from .env.local.
 * Links CLI to the target site and copies env vars from the source site.
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

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

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/switch-netlify-site.mjs <site-name-or-id>');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

// Find target site
const sites = await fetch('https://api.netlify.com/api/v1/sites', { headers }).then(r => r.json());
const site = sites.find(s => s.id === target || s.name === target || s.ssl_url?.includes(target));
if (!site) {
  console.error(`Site "${target}" not found. Available:`);
  sites.forEach(s => console.error(`  ${s.name} (${s.id})`));
  process.exit(1);
}

console.log(`Switching to: ${site.name} (${site.id})`);
console.log(`URL: ${site.ssl_url}`);

// Link CLI
execSync(`npx netlify link --id ${site.id}`, { stdio: 'inherit' });

// Check env var count
const envVars = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/env`, { headers }).then(r => r.json());
const count = Array.isArray(envVars) ? envVars.length : Object.keys(envVars).length;
console.log(`\nEnv vars on ${site.name}: ${count}`);

// Check required vars
const REQUIRED = [
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'WS_RELAY_URL', 'RELAY_SHARED_SECRET',
  'CLERK_JWT_ISSUER_DOMAIN', 'CLERK_SECRET_KEY',
  'WM_SESSION_SECRET', 'FRED_API_KEY',
];

const envMap = Array.isArray(envVars)
  ? Object.fromEntries(envVars.map(e => [e.key, e.values?.[0]?.value]))
  : envVars;

const missing = REQUIRED.filter(k => !envMap[k]);
if (missing.length > 0) {
  console.warn(`\nMissing required env vars:`);
  missing.forEach(k => console.warn(`  - ${k}`));
  console.warn(`\nTo copy from another site, use:`);
  console.warn(`  node scripts/copy-netlify-env.mjs <source-site> ${site.name}`);
} else {
  console.log('\nAll required env vars present.');
}

console.log(`\nDone. Deploy with: netlify deploy --prod --no-build --dir dist --functions functions`);
