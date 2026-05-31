#!/usr/bin/env node
// @ts-check
/**
 * Scenario Engine Worker — always-on Railway service
 *
 * Atomically dequeues scenario jobs from Redis using BLMOVE (Redis 6.2 / Upstash),
 * runs computeScenario(), and writes results back to Redis with a 24-hour TTL.
 *
 * Railway config:
 *   rootDirectory: scripts
 *   startCommand:  node scenario-worker.mjs
 *   vCPUs: 1 / memoryGB: 1
 *   cronSchedule:  <none> (always-on long-running process)
 */

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const QUEUE_KEY = 'scenario-queue:pending';
const PROCESSING_KEY = 'scenario-queue:processing';
const RESULT_TTL_SECONDS = 86_400; // 24 h
const BLMOVE_TIMEOUT_SECONDS = 30;  // block for up to 30s waiting for a job

/** @typedef {{ jobId: string; scenarioId: string; iso2: string | null; enqueuedAt: number }} ScenarioJob */

/**
 * Inline copy of SCENARIO_TEMPLATES (no TypeScript import).
 * Keep in sync with server/worldmonitor/supply-chain/v1/scenario-templates.ts.
 * Worker only needs: id, affectedChokepointIds, disruptionPct, durationDays, affectedHs2, costShockMultiplier.
 *
 * @type {Array<{ id: string; affectedChokepointIds: string[]; disruptionPct: number; durationDays: number; affectedHs2: string[] | null; costShockMultiplier: number }>}
 */
const SCENARIO_TEMPLATES = [
  {
    id: 'taiwan-strait-full-closure',
    affectedChokepointIds: ['taiwan_strait'],
    disruptionPct: 100,
    durationDays: 30,
    affectedHs2: ['84', '85', '87'],
    costShockMultiplier: 1.45,
  },
  {
    id: 'suez-bab-simultaneous',
    affectedChokepointIds: ['suez', 'bab_el_mandeb'],
    disruptionPct: 80,
    durationDays: 60,
    affectedHs2: null,
    costShockMultiplier: 1.35,
  },
  {
    id: 'panama-drought-50pct',
    affectedChokepointIds: ['panama'],
    disruptionPct: 50,
    durationDays: 90,
    affectedHs2: null,
    costShockMultiplier: 1.22,
  },
  {
    id: 'hormuz-tanker-blockade',
    affectedChokepointIds: ['hormuz_strait'],
    disruptionPct: 100,
    durationDays: 14,
    affectedHs2: ['27', '29'],
    costShockMultiplier: 2.10,
  },
  {
    id: 'russia-baltic-grain-suspension',
    affectedChokepointIds: ['bosphorus', 'dover_strait'],
    disruptionPct: 100,
    durationDays: 180,
    affectedHs2: ['10', '12'],
    costShockMultiplier: 1.55,
  },
  {
    id: 'us-tariff-escalation-electronics',
    affectedChokepointIds: [],
    disruptionPct: 0,
    durationDays: 365,
    affectedHs2: ['85'],
    costShockMultiplier: 1.50,
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Redis helpers (Upstash REST API)
// ────────────────────────────────────────────────────────────────────────────

/** @returns {{ url: string; token: string }} */
function getCredentials() {
  return getRedisCredentials();
}

/**
 * Execute a raw Redis command via Upstash REST API.
 * Uses the base-URL POST format (command as first body element) which is the only
 * format Upstash supports reliably — POST /{cmd} with args-only body is broken.
 * @param {string} cmd  e.g. "BLMOVE"
 * @param {unknown[]} args
 */
async function redisCmd(cmd, args) {
  const results = await cfPipeline([[cmd.toUpperCase(), ...args]]);
  return results[0];
}