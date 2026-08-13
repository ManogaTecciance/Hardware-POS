/**
 * Session persistence shared by the auth context and the API client.
 * Lives outside React so `api.ts` can rotate tokens (refresh-on-401) and the
 * AuthProvider can observe the change without a circular import.
 */

import { Permission, permissionsForRole, type UserRole } from './permissions';

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  tenantId: string;
  permissions: Permission[];
}

export interface Session {
  token: string;
  /** Long-lived rotating token used to mint new access tokens on 401. */
  refreshToken?: string;
  user: SessionUser;
  /**
   * D55 — this session belongs to the platform console, not a workspace. The
   * app routes it to /platform and the API refuses it every workspace route.
   */
  isPlatformAdmin?: boolean;
  /** Selling location for this session, as stated by the server at login. */
  branchId: string | null;
  registerId: string | null;
  branchName: string;
  registerName: string;
}

const STORAGE_KEY = 'hpos.session';

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

export function loadSession(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Stale sessions from the removed offline demo mode can't reach the API.
    if (parsed.token.startsWith('mock.')) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // Permissions are derived from the role, never trusted from storage: a
    // session saved before a permission was added to ROLE_PERMISSIONS would
    // otherwise hide new features (e.g. nav items) until re-login.
    parsed.user.permissions = permissionsForRole(parsed.user.role);
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  if (typeof window !== 'undefined') {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((fn) => fn(session));
}

/** Observe session replacements (e.g. a token refresh performed by the API client). */
export function subscribeSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
