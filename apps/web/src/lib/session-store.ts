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
  /**
   * Display name of the role that granted this session's permissions ("Waiter").
   * `role` is the legacy enum and can disagree with the real authority; show
   * this one. Optional because a session minted before the field existed may
   * still be in localStorage — fall back to the enum then.
   */
  roleName?: string;
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
    /*
     * D88 — trust what the server resolved, and re-derive only when there is
     * nothing to trust.
     *
     * This used to overwrite the stored set with `permissionsForRole(role)` on
     * every load. That is correct only for a user whose authority still comes
     * from their enum role. A user linked to a custom role has the enum role
     * CASHIER and an entirely different authority, so a waiter who pressed F5
     * silently became a retail cashier: dine-in and bill splitting vanished,
     * and Sales — which the API refuses them — appeared. `toSession` was fixed
     * to keep the server's set at login; this threw it away again on the next
     * page load, which is why the defect only ever showed after a reload.
     *
     * The original concern still holds for a session stored before the field
     * existed: it has no permissions at all, and the enum is the only thing
     * left to derive them from.
     */
    if (!Array.isArray(parsed.user.permissions) || parsed.user.permissions.length === 0) {
      parsed.user.permissions = permissionsForRole(parsed.user.role);
    }
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
