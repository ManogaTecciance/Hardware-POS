import { SetMetadata } from '@nestjs/common';

/**
 * Every route in the API answers to one of four scopes, per Phase 1.5.6.
 *
 * `TENANT_SCOPED`    — tenant-wide administration. No `activeBranchId` required.
 *                      Example: platform profile read, roles administration.
 * `BRANCH_SCOPED`    — the caller acts on a specific branch's data. The token's
 *                      `activeBranchId` must resolve to a branch the caller has
 *                      access to right now (D38, AD-04). Fail-closed.
 * `REGISTER_SCOPED`  — needs both a branch and a register within it. Adds a
 *                      register-membership check on top of `BRANCH_SCOPED`.
 * `GLOBAL_PLATFORM`  — not tenant-scoped at all. Reserved for health and public
 *                      routes. Guard is a no-op.
 *
 * Routes without metadata default to `TENANT_SCOPED` — the guard is a no-op —
 * so introducing the guard cannot regress existing behaviour by omission. The
 * route-module-matrix test enforces that a scope classification exists for
 * every served route.
 */
export enum BranchScopeKind {
  TENANT_SCOPED = 'TENANT_SCOPED',
  BRANCH_SCOPED = 'BRANCH_SCOPED',
  REGISTER_SCOPED = 'REGISTER_SCOPED',
  GLOBAL_PLATFORM = 'GLOBAL_PLATFORM',
}

export const BRANCH_SCOPE_METADATA = 'axlopos:branch-scope';

export const BranchScope = (kind: BranchScopeKind) => SetMetadata(BRANCH_SCOPE_METADATA, kind);
