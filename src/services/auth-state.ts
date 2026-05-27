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
