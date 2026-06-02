// @ts-check
// Idempotent persistence + index pruning + dedup guard.
// Implements the persist step of the seed pipeline.

import { getRedisCredentials, cfPipeline } from '../_seed-utils.mjs';

const SNAPSHOT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const DEDUP_TTL_SECONDS = 900; // 15 min
const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Persist a snapshot atomically with idempotency guard and index pruning.
 * Returns whether the persist actually happened (false = dedupe skip).
 *
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @returns {Promise<{ persisted: boolean; reason: string }>}
 */
export async function persistSnapshot(snapshot) {
  const { url, token } = getRedisCredentials();
  if (!url || !token) {
    return { persisted: false, reason: 'no-redis-credentials' };
  }

  const region = snapshot.region_id;
  const snapshotId = snapshot.meta.snapshot_id;
  const triggerReason = snapshot.meta.trigger_reason;
  const timestamp = snapshot.generated_at;
  const bucket = Math.floor(timestamp / (15 * 60_000)); // 15-min bucket

  // 1. Idempotency check via atomic SET NX EX (single round-trip; SETNX + EXPIRE
  //    would be a race that leaks a permanent dedup key on EXPIRE failure).
  const dedupKey = `dedup:snapshot:v1:${region}:${triggerReason}:${bucket}`;
  let dedupJson;
  try {
    dedupJson = await cfPipeline([['SET', dedupKey, snapshotId, 'EX', String(DEDUP_TTL_SECONDS), 'NX']]);
  } catch (err) {
    return { persisted: false, reason: `dedup-error-${err?.message || 'unknown'}` };
  }
  // SET ... NX returns 'OK' on success, null when the key already exists.
  if (!dedupJson?.[0] || dedupJson[0].result == null) {
    return { persisted: false, reason: 'duplicate-bucket' };
  }

  // 2. Persist (single pipeline)
  const json = JSON.stringify(snapshot);
  const tsKey = `intelligence:snapshot:v1:${region}:${timestamp}`;
  const idKey = `intelligence:snapshot-by-id:v1:${snapshotId}`;
  const latestKey = `intelligence:snapshot:v1:${region}:latest`;
  const indexKey = `intelligence:snapshot-index:v1:${region}`;
  const liveKey = `intelligence:snapshot:v1:${region}:live`;
  const pruneCutoff = Date.now() - PRUNE_AGE_MS;

  const pipeline = [
    ['SET', tsKey, json, 'EX', String(SNAPSHOT_TTL_SECONDS)],
    ['SET', idKey, json, 'EX', String(SNAPSHOT_TTL_SECONDS)],
    ['SET', latestKey, snapshotId, 'EX', String(SNAPSHOT_TTL_SECONDS)],
    ['ZADD', indexKey, String(timestamp), snapshotId],
    ['ZREMRANGEBYSCORE', indexKey, '-inf', `(${pruneCutoff}`],
    ['DEL', liveKey],
  ];

  try {
    await cfPipeline(pipeline);
  } catch (err) {
    return { persisted: false, reason: `pipeline-error-${err?.message || 'unknown'}` };
  }

  return { persisted: true, reason: 'ok' };
}

/**
 * Read the latest persisted snapshot for a region. Used by the diff engine
 * (compares prev vs curr) and by tests.
 *
 * @param {string} regionId
 * @returns {Promise<import('../../shared/regions.types.js').RegionalSnapshot | null>}
 */
export async function readLatestSnapshot(regionId) {
  try {
    const latestKey = `intelligence:snapshot:v1:${regionId}:latest`;
    const idResults = await cfPipeline([['GET', latestKey]]);
    const snapshotId = idResults?.[0]?.result;
    if (!snapshotId) return null;

    const snapKey = `intelligence:snapshot-by-id:v1:${snapshotId}`;
    const snapResults = await cfPipeline([['GET', snapKey]]);
    const raw = snapResults?.[0]?.result;
    if (!raw) return null;

    return JSON.parse(raw);
  } catch {
    return null;
  }
}
