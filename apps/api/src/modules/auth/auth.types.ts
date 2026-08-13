import { UserRole } from '@hardware-pos/database';

/**
 * Signed into the JWT and re-hydrated on each request.
 *
 * `activeBranchId` is the branch this session is *currently* operating from.
 * Under decision D38 / AD-03 the token carries it as CONTEXT, never as
 * authorisation: every branch-scoped request re-validates that the user still
 * has access to the branch. See `BranchScopeGuard`.
 *
 * `null` means the caller is operating tenant-wide (OWNER/ADMIN who did not
 * choose a specific branch, or a legacy token issued before Phase 1.5.6).
 */
export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
  activeBranchId?: string | null;
}

/** Attached to `request.user` by the JWT guard. */
export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  role: UserRole;
  /**
   * The branch this session is currently operating from. `null` when the token
   * predates Phase 1.5.6 or the caller chose the tenant-wide view. Never trust
   * this for authorisation — `BranchScopeGuard` re-checks the database.
   */
  activeBranchId: string | null;
}

export interface AuthTokenResult {
  /** Short-lived JWT access token. */
  token: string;
  /** Long-lived opaque refresh token — exchange at POST /auth/refresh. */
  refreshToken: string;
  user: {
    id: string;
    tenantId: string;
    name: string;
    email: string | null;
    role: UserRole;
  };
  /**
   * The permissions this session actually holds, resolved the same way
   * `PermissionsGuard` resolves them. The client must not re-derive these from
   * `user.role`: a user linked to a custom role (a waiter, say) has an enum
   * role of CASHIER and an entirely different authority.
   */
  permissions: string[];
  /** Where this session sells from — the user's branch (or tenant default). */
  branch: { id: string; name: string } | null;
  /** The branch's default register. */
  register: { id: string; name: string } | null;
}
