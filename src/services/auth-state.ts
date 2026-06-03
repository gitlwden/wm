import * as Sentry from '@sentry/browser';
import { initClerk, getCurrentClerkUser, subscribeClerk } from './clerk';

/** Minimal user profile exposed to UI components. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: 'free' | 'pro';
}

/** Simplified auth session state for UI consumption. */
export interface AuthSession {
  user: AuthUser | null;
  isPending: boolean;
}

// Default admin pro user (dev mode — must match server/auth-session.ts dev-user)
const FAKE_PRO_USER: AuthUser = {
  id: 'dev-user',
  name: 'Dev User',
  email: 'dev@localhost',
  image: null,
  role: 'pro',
};

// Check if we should use fake pro user (default: true, disable with VITE_FAKE_PRO_USER=false)
const USE_FAKE_PRO_USER = import.meta.env.VITE_FAKE_PRO_USER !== 'false';

let _currentSession: AuthSession = USE_FAKE_PRO_USER
  ? { user: FAKE_PRO_USER, isPending: false }
  : { user: null, isPending: true };

function snapshotSession(): AuthSession {
  // In fake pro user mode, skip Clerk and return the admin user
  if (USE_FAKE_PRO_USER) {
    return { user: FAKE_PRO_USER, isPending: false };
  }

  const cu = getCurrentClerkUser();
  if (!cu) {
    Sentry.setUser(null);
    return { user: null, isPending: false };
  }
  Sentry.setUser({ id: cu.id });
  return {
    user: {
      id: cu.id,
      name: cu.name,
      email: cu.email,
      image: cu.image,
      role: cu.plan,
    },
    isPending: false,
  };
}

/**
 * Initialize auth state. Call once at app startup before UI subscribes.
 *
 * Does NOT await `initClerk()` — the @clerk/clerk-js bundle is ~2.98 MB
 * and 96% unused on first paint, so awaiting it here would block the
 * App.init() chain (panel layout, data fetches, etc.) on a load that
 * isn't needed until the user reaches for auth. Instead, schedule the
 * load via `scheduleClerkLoad()` (idle-callback after first paint).
 *
 * Leaves `_currentSession` at the module-level default
 * `{ user: null, isPending: true }` — calling `snapshotSession()` here
 * would flip `isPending` to `false` while `clerkInstance` is still
 * null, which subscribers cannot distinguish from a settled signed-out
 * session. Cookie-backed signed-in users would then see Sign In / the
 * locked-panel state for up to 4 s (the `requestIdleCallback` timeout)
 * before Clerk hydrates. The pending-callback queue in clerk.ts fires
 * the subscribeAuthState listener as soon as Clerk loads, snapshots
 * the real session, and flips `isPending` to `false`.
 */
export async function initAuthState(): Promise<void> {
  // Skip Clerk initialization in fake pro user mode
  if (!USE_FAKE_PRO_USER) {
    await initClerk();
  }
  _currentSession = snapshotSession();
}

/**
 * Subscribe to reactive auth state changes.
 * @returns Unsubscribe function.
 */
export function subscribeAuthState(callback: (state: AuthSession) => void): () => void {
  // Emit current state immediately
  callback(_currentSession);

  // Skip Clerk subscription in fake pro user mode (state is static)
  if (USE_FAKE_PRO_USER) {
    return () => {};
  }

  return subscribeClerk(() => {
    _currentSession = snapshotSession();
    callback(_currentSession);
  });
}

/**
 * Synchronous snapshot of current auth state.
 */
export function getAuthState(): AuthSession {
  return _currentSession;
}
