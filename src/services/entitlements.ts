/**
 * Frontend entitlement service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time entitlement
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 */

import { getConvexClient, getConvexApi, waitForConvexAuth } from './convex-client';
import { getAuthState } from './auth-state';

/** Pro plan feature defaults — used for Clerk-role fallback when Convex has no entitlement record.
 *  Must match convex/config/productCatalog.ts PRO_FEATURES. */
const PRO_CLERK_FALLBACK_FEATURES: EntitlementState['features'] = {
  tier: 1,
  apiAccess: true,
  apiRateLimit: 30,
  maxDashboards: 10,
  prioritySupport: false,
  exportFormats: ['csv', 'pdf'],
  mcpAccess: true,
};

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    /**
     * Pro MCP access (plan 2026-05-10-001). Undefined on legacy entitlement
     * snapshots that pre-date the catalog field. `hasFeature('mcpAccess')`
     * coerces undefined → false via Boolean(), so the settings tab
     * fails-closed for unrefreshed Pro users (they'll see it appear once
     * Dodo's next webhook repopulates the field).
     */
    mcpAccess?: boolean;
  };
  validUntil: number;
}

// Module-level state
let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let initialized = false;
let unsubscribeFn: (() => void) | null = null;

/**
 * Initialize the entitlement subscription for the authenticated user.
 * Idempotent — calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initEntitlementSubscription(_userId?: string): Promise<void> {
  console.log('[entitlements] initEntitlementSubscription called, initialized=', initialized);
  if (initialized) return;

  try {
    const client = await getConvexClient();
    if (!client) {
      console.warn('[entitlements] No VITE_CONVEX_URL — skipping Convex subscription');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      console.log('[entitlements] Could not load Convex API — skipping subscription');
      return;
    }

    // Wait for Convex to confirm auth before subscribing. Otherwise the first
    // getEntitlementsForUser snapshot runs unauthenticated and returns
    // FREE_TIER_DEFAULTS, which can race with the post-payment panel gating
    // decision (the UI renders as free before the auth-ready pro snapshot
    // arrives). Unauthenticated visitors time out after 10s and we skip the
    // subscription entirely — they don't need entitlement updates.
    const authed = await waitForConvexAuth(10_000);
    console.log('[entitlements] Convex auth result:', authed);
    if (!authed) {
      console.warn('[entitlements] Convex auth not established — skipping subscription');
      return;
    }

    const watch = client.onUpdate(
      api.entitlements.getEntitlementsForUser,
      {},
      (result: EntitlementState | null) => {
        console.log('[entitlements] Convex snapshot:', JSON.stringify(result));
        currentState = result;
        for (const cb of listeners) cb(result);
      },
      (err: Error) => {
        console.warn('[entitlements] Subscription query error:', err.message);
      },
    );

    unsubscribeFn = watch.unsubscribe;
    initialized = true;
  } catch (err) {
    console.error('[entitlements] Failed to initialize Convex subscription:', err);
    // Do not rethrow — entitlement service failure must not break the dashboard
  }
}

/**
 * Tears down the entitlement subscription and clears all listeners.
 * Resets initialized flag so a new subscription can be started.
 * Does NOT null currentState — preserves the last known state across
 * destroy/reinit cycles (e.g. WebSocket reconnects) so paying users don't
 * see locked panels during backoff. Call resetEntitlementState() on sign-out.
 */
export function destroyEntitlementSubscription(): void {
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }
  // Keep listeners intact — PanelLayout registers them once and expects them
  // to survive auth transitions. Only the Convex transport is torn down.
  initialized = false;
}

/**
 * Explicitly nulls currentState. Call on sign-out to prevent the previous
 * user's entitlements from leaking into a subsequent session.
 * Distinct from destroyEntitlementSubscription() which preserves state for reconnects.
 */
export function resetEntitlementState(): void {
  currentState = null;
}

/**
 * Register a callback for entitlement changes.
 * If entitlement state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onEntitlementChange(
  cb: (state: EntitlementState | null) => void,
): () => void {
  listeners.add(cb);

  // Late subscribers get the current value immediately
  if (currentState !== null) {
    cb(currentState);
  }

  return () => {
    listeners.delete(cb);
  };
}

/**
 * Returns the current entitlement state, or null if not yet loaded.
 */
export function getEntitlementState(): EntitlementState | null {
  return currentState;
}

/**
 * Check if we should use fake pro user entitlements (default: true).
 * Disable with VITE_FAKE_PRO_USER=false.
 */
function useFakeProUser(): boolean {
  return import.meta.env.VITE_FAKE_PRO_USER !== 'false';
}

/**
 * Returns true when the Clerk user has role 'pro' (set via publicMetadata.plan).
 * Authoritative signal — takes priority over Convex entitlement state.
 */
function isClerkPro(): boolean {
  return getAuthState().user?.role === 'pro';
}

/**
 * Check whether a specific feature flag is truthy in the current entitlement state.
 * In fake pro user mode, always returns true for all features.
 *
 * Clerk Pro role takes priority over Convex entitlement — Clerk is the
 * authoritative identity source. A Clerk Pro user whose Convex entitlement
 * hasn't synced yet (webhook delay, missing record) should not see upgrade
 * prompts for features their plan includes.
 */
export function hasFeature(flag: keyof EntitlementState['features']): boolean {
  // In fake pro user mode, fake pro user has all features
  if (currentState === null && useFakeProUser()) return true;
  // Clerk Pro role is authoritative — use Pro feature set
  if (isClerkPro()) return Boolean(PRO_CLERK_FALLBACK_FEATURES[flag]);
  if (currentState === null) return false;
  return Boolean(currentState.features[flag]);
}

/**
 * Check whether the user's tier meets or exceeds the given minimum.
 * In fake pro user mode, always returns true.
 *
 * Clerk Pro role takes priority over Convex entitlement — see hasFeature.
 */
export function hasTier(minTier: number): boolean {
  // In fake pro user mode, fake pro user has tier 1
  if (currentState === null && useFakeProUser()) return minTier <= 1;
  // Clerk Pro role is authoritative — Pro has tier 1
  if (isClerkPro()) return PRO_CLERK_FALLBACK_FEATURES.tier >= minTier;
  if (currentState === null) return false;
  return currentState.features.tier >= minTier;
}

/**
 * Simple "is this a paying user" check.
 * Returns true if entitlement data exists, plan is not free, and hasn't expired.
 * In fake pro user mode, always returns true.
 */
export function isEntitled(): boolean {
  // In fake pro user mode, fake pro user is always entitled
  if (currentState === null && useFakeProUser()) return true;
  // Clerk Pro role is authoritative
  if (isClerkPro()) return true;
  return (
    currentState !== null &&
    currentState.planKey !== 'free' &&
    currentState.validUntil >= Date.now()
  );
}

/**
 * Decides whether to reload the page when an entitlement snapshot arrives.
 *
 * Rules:
 *   - First snapshot ever (last === null): never reload. A legacy-pro user
 *     whose first snapshot is already `true` must not trigger a reload loop
 *     on every page load.
 *   - Free → pro transition (last === false, next === true): reload. This is
 *     the post-payment activation case — panels rendered against free-tier
 *     gating need to re-render to pick up the new entitlement.
 *   - Everything else (free→free, pro→pro, pro→free): no reload.
 */
export function shouldReloadOnEntitlementChange(
  last: boolean | null,
  next: boolean,
): boolean {
  return last === false && next === true;
}
