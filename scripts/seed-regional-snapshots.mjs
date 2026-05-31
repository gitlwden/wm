#!/usr/bin/env node
import { pathToFileURL , cfPipeline } from 'node:url';

import { loadEnvFile, getRedisCredentials, writeExtraKeyWithMeta } from './_seed-utils.mjs';
// @ts-check
/**
 * Regional Intelligence snapshot seeder.
 *
 * Computes a RegionalSnapshot per region using deterministic scoring across
 * seven balance axes, derives a regime label, scores actors, evaluates
 * structured trigger thresholds, builds normalized scenario sets, resolves
 * pre-built transmission templates, and persists to Redis with idempotency.
 *
 * Phase 1 (PR2): LLM narrative layer added. One structured-JSON call per
 * region via generateRegionalNarrative(), ship-empty on any failure. The
 * 'global' region is skipped inside the generator. Provider + model flow
 * through SnapshotMeta.narrative_provider / narrative_model.
 *
 * Architecture: docs/internal/pro-regional-intelligence-upgrade.md
 * Engineering:  docs/internal/pro-regional-intelligence-appendix-engineering.md
 * Scoring:      docs/internal/pro-regional-intelligence-appendix-scoring.md
 *
 * Run via the seed bundle (recommended) or directly:
 *   node scripts/seed-regional-snapshots.mjs
 */

import { pathToFileURL } from 'node:url';

// Use scripts/shared mirror rather than the repo-root shared/ folder: the
// Railway bundle service sets rootDirectory=scripts, so `../shared/` resolves
// to filesystem / on deploy and the import fails with ERR_MODULE_NOT_FOUND.
// scripts/shared/* is kept in sync with shared/* via tests.
import { REGIONS, GEOGRAPHY_VERSION } from './shared/geography.js';

import { computeBalanceVector, SCORING_VERSION } from './regional-snapshot/balance-vector.mjs';
import { buildRegimeState } from './regional-snapshot/regime-derivation.mjs';
import { scoreActors } from './regional-snapshot/actor-scoring.mjs';
import { evaluateTriggers } from './regional-snapshot/trigger-evaluator.mjs';
import { buildScenarioSets } from './regional-snapshot/scenario-builder.mjs';
import { resolveTransmissions } from './regional-snapshot/transmission-templates.mjs';
import { collectEvidence } from './regional-snapshot/evidence-collector.mjs';
import { buildPreMeta, buildFinalMeta } from './regional-snapshot/snapshot-meta.mjs';
import { diffRegionalSnapshot, inferTriggerReason } from './regional-snapshot/diff-snapshot.mjs';
import { persistSnapshot, readLatestSnapshot } from './regional-snapshot/persist-snapshot.mjs';
import { ALL_INPUT_KEYS, ALL_META_KEYS } from './regional-snapshot/freshness.mjs';
import { generateSnapshotId } from './regional-snapshot/_helpers.mjs';
import { generateRegionalNarrative, emptyNarrative } from './regional-snapshot/narrative.mjs';
import { emitRegionalAlerts } from './regional-snapshot/alert-emitter.mjs';
import { buildMobilityState } from './regional-snapshot/mobility.mjs';
import { recordRegimeTransition } from './regional-snapshot/regime-history.mjs';

loadEnvFile(import.meta.url);

const SEED_META_KEY = 'intelligence:regional-snapshots';

/**
 * Read every input key + every metaKey companion in a single pipeline.
 * metaKeys carry {fetchedAt, recordCount} for inputs whose data payload
 * has no top-level timestamp (mobility sources). See freshness.mjs.
 *
 * @returns {Promise<{ sources: Record<string, any>, metaSources: Record<string, any> }>}
 */
async function readAllInputs() {
  const keys = [...ALL_INPUT_KEYS, ...ALL_META_KEYS];
  const commands = keys.map((k) => ['GET', k]);
  const results = await cfPipeline(commands);

  /** @type {Record<string, any>} */
  const sources = {};
  /** @type {Record<string, any>} */
  const metaSources = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const target = i < ALL_INPUT_KEYS.length ? sources : metaSources;
    const raw = results[i]?.result;
    if (raw === null || raw === undefined) {
      target[key] = null;
      continue;
    }
    try {
      target[key] = JSON.parse(raw);
    } catch {
      target[key] = null;
    }
  }