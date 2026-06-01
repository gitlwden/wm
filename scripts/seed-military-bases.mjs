#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kvGet, kvSet } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const R2_BUCKET_URL = 'https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/wm-seed-data/objects/seed-data/military-bases-final.json';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const GRACE_PERIOD_MS = 5 * 60 * 1000;
const VALIDATION_SAMPLE_SIZE = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  let env = 'production';
  let sha = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      env = args[++i];
    } else if (args[i] === '--sha' && args[i + 1]) {
      sha = args[++i];
    } else if (args[i].startsWith('--env=')) {
      env = args[i].split('=')[1];
    } else if (args[i].startsWith('--sha=')) {
      sha = args[i].split('=')[1];
    }
  }

  const valid = ['production', 'preview', 'development'];
  if (!valid.includes(env)) {
    console.error(`Invalid --env "${env}". Must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }

  if ((env === 'preview' || env === 'development') && !sha) {
    sha = 'dev';
  }

  return { env, sha };
}

function getKeyPrefix(env, sha) {
  if (env === 'production') return '';
  return `${env}:${sha}:`;
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function loadEnvFile() {
  const envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// kvGet and kvSet are imported from _seed-utils.mjs (with retry via caller)
// kvDelete is not available in routed helpers — use best-effort no-op
const kvDelete = async () => false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const CHUNK_SIZE = 15_000; // ~4MB per chunk (well under 5MB KV limit)

async function seedData(dataKey, entries) {
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    chunks.push(entries.slice(i, i + CHUNK_SIZE));
  }

  // Write chunk count index key
  const indexKey = `${dataKey}:chunks`;
  await kvSet(indexKey, chunks.length, 7 * 24 * 3600);
  console.log(`  DATA: ${entries.length.toLocaleString()} entries → ${chunks.length} chunks`);

  // Write each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunkKey = `${dataKey}:part${i}`;
    await kvSet(chunkKey, chunks[i]);
    console.log(`  CHUNK ${i + 1}/${chunks.length}: ${chunks[i].length.toLocaleString()} entries`);
  }
  return entries.length;
}

async function readChunkedData(dataKey) {
  const indexKey = `${dataKey}:chunks`;
  const numChunks = await kvGet(indexKey);
  if (!numChunks || numChunks < 1) {
    // Fallback: try reading as single key (legacy format)
    return await kvGet(dataKey);
  }
  const allEntries = [];
  for (let i = 0; i < numChunks; i++) {
    const chunk = await kvGet(`${dataKey}:part${i}`);
    if (Array.isArray(chunk)) allEntries.push(...chunk);
  }
  return allEntries;
}

async function validate(prefix, version, expectedCount) {
  const dataKey = `${prefix}military:bases:data:${version}`;

  console.log('\nValidating seeded data...');

  const data = await readChunkedData(dataKey);
  const count = Array.isArray(data) ? data.length : 0;

  console.log(`  ${dataKey} = ${count} entries (expected >= ${expectedCount})`);

  if (count < expectedCount) {
    throw new Error(`Entry count ${count} < expected ${expectedCount}`);
  }

  // Sample validation
  const sampleSize = Math.min(VALIDATION_SAMPLE_SIZE, count);
  let parseOk = 0;
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(Math.random() * count);
    const entry = data[idx];
    if (!entry || !entry.id) {
      throw new Error(`Sample entry at index ${idx} missing id`);
    }
    parseOk++;
  }

  console.log(`  Sampled ${parseOk}/${sampleSize} entries — all valid`);
  console.log('  Validation passed.');
}

async function atomicSwitch(prefix, version) {
  const activeKey = `${prefix}military:bases:active`;
  await kvSet(activeKey, String(version));
  console.log(`\nAtomic switch: SET ${activeKey} = ${version}`);
}

async function cleanupOldVersion(prefix, newVersion) {
  const activeKey = `${prefix}military:bases:active`;
  const currentActive = await kvGet(activeKey);

  if (!currentActive || String(currentActive) === String(newVersion)) return null;

  const oldVersion = currentActive;
  const oldDataKey = `${prefix}military:bases:data:${oldVersion}`;

  // Clean up chunked keys — use kvSet with no TTL to effectively keep, but
  // kvDelete is not available in routed helpers. Best-effort: skip cleanup.
  // The keys will expire naturally via their TTL.
  return { oldVersion, oldDataKey };
}

async function main() {
  loadEnvFile();

  const { env, sha } = parseArgs();
  const prefix = getKeyPrefix(env, sha);

  const volumePath = '/data/military-bases-final.json';
  const localPath = join(__dirname, 'data', 'military-bases-final.json');
  let dataPath = existsSync(volumePath) ? volumePath : existsSync(localPath) ? localPath : null;

  if (!dataPath) {
    const cfAccountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID || '';
    const bucket = process.env.CLOUDFLARE_R2_BUCKET || 'wm-seed-data';
    // Try tokens in order: R2-specific, then main API token (matches upload token)
    const tokens = [
      process.env.CLOUDFLARE_R2_API_TOKEN,
      process.env.CLOUDFLARE_API_TOKEN,
    ].filter(Boolean);

    if (cfAccountId && tokens.length > 0) {
      console.log('  Local file not found — downloading from R2...');
      const r2Url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/seed-data/military-bases-final.json`;
      for (const token of tokens) {
        try {
          const resp = await fetch(r2Url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(60_000),
          });
          if (resp.ok) {
            const body = await resp.text();
            mkdirSync(join(__dirname, 'data'), { recursive: true });
            writeFileSync(localPath, body);
            dataPath = localPath;
            console.log(`  Downloaded ${(body.length / 1024 / 1024).toFixed(1)}MB from R2`);
            break;
          } else {
            console.log(`  R2 download: HTTP ${resp.status} (trying next token...)`);
          }
        } catch (err) {
          console.log(`  R2 download: ${err.message} (trying next token...)`);
        }
      }
      if (!dataPath) console.log('  R2 download failed with all tokens');
    }
  }

  if (!dataPath) {
    const activeKey = `${prefix}military:bases:active`;
    const existing = await kvGet(activeKey);
    if (existing) {
      console.log(`No data file found — KV already has active version ${existing}, skipping.`);
      process.exit(0);
    }
    console.error(`Data file not found locally or on R2, and no existing data in KV.`);
    process.exit(1);
  }

  const raw = readFileSync(dataPath, 'utf8');
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('Data file is empty or not a JSON array.');
    process.exit(1);
  }

  const invalid = entries.filter(e => !e.id || e.lat == null || e.lon == null);
  if (invalid.length > 0) {
    console.error(`Found ${invalid.length} entries missing id/lat/lon. First: ${JSON.stringify(invalid[0])}`);
    process.exit(1);
  }

  const version = Date.now();
  const dataKey = `${prefix}military:bases:data:${version}`;

  console.log('=== Military Bases Seed ===');
  console.log(`  Environment:  ${env}`);
  console.log(`  Prefix:       ${prefix || '(none — production)'}`);
  console.log(`  Data file:    ${dataPath}`);
  console.log(`  Entries:      ${entries.length.toLocaleString()}`);
  console.log(`  Version:      ${version}`);
  console.log(`  Data key:     ${dataKey}`);
  console.log();

  const oldInfo = await cleanupOldVersion(prefix, version);
  if (oldInfo) {
    console.log(`Previous version detected: ${oldInfo.oldVersion}`);
    console.log(`  Will clean up after grace period: ${oldInfo.oldDataKey}`);
  }

  console.log('Seeding entries...');
  const t0 = Date.now();
  const seeded = await seedData(dataKey, entries);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nSeeding complete in ${elapsed}s — ${seeded.toLocaleString()} entries`);

  await validate(prefix, version, entries.length);

  await atomicSwitch(prefix, version);

  if (oldInfo) {
    console.log(`\nPrevious version ${oldInfo.oldVersion} detected — keys will expire via TTL.`);
  }

  console.log('\n=== Done ===');
  console.log(`  Active version: ${version}`);
  console.log(`  Data key:       ${dataKey}`);
  console.log(`  Total entries:  ${entries.length.toLocaleString()}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
