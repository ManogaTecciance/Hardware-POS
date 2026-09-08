import { Injectable, Logger } from '@nestjs/common';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';
import { Permission } from './permissions';

/** Where a request's permissions came from. Reported, never inferred. */
export type AuthoritySource = 'DATABASE' | 'LEGACY_FALLBACK' | 'DENIED';

export interface ResolvedAuthority {
  source: AuthoritySource;
  permissions: ReadonlySet<Permission>;
  /** Set when the source is DENIED — why, for the audit trail and diagnostics. */
  reason?: string;
  /**
   * Display name of the role row that granted these permissions (DATABASE
   * source only). The enum on `User.role` is a legacy label that can disagree
   * with the real authority — a waiter's enum says CASHIER — so callers that
   * show a role to a human should show this, falling back to the enum only
   * when there is no row.
   */
  roleName?: string;
}

const CATALOGUE = new Set<string>(ALL_PERMISSIONS);

/**
 * Resolves the permissions a request actually carries (Phase 1.5.4, D37).
 *
 * ## The resolution rule, stated once
 *
 * 1. `User.roleId` is null → **LEGACY_FALLBACK**: `ROLE_PERMISSIONS[user.role]`.
 *    This is the not-yet-migrated user, and it is the only condition under which
 *    the legacy authority is consulted.
 * 2. `User.roleId` is set and the role resolves within the user's own tenant →
 *    **DATABASE**: exactly the role's assigned permissions.
 * 3. `User.roleId` is set and the role does not resolve — deleted, or belonging to
 *    another tenant → **DENIED**: no permissions at all.
 *
 * ## Why case 3 is not a fallback
 *
 * Falling back to `User.role` when the database link is broken would mean a
 * deliberately-restricted user regains their legacy permissions the moment their
 * role row is deleted. Deletion would become an escalation. A user whose role
 * cannot be resolved holds nothing and is told so by a 403 — that is what "fail
 * closed" means here, and it is the difference between an outage and a breach.
 *
 * ## Why the union is never taken
 *
 * `DATABASE ∪ LEGACY` would make every migrated user at least as powerful as they
 * were before, so a permission removed from a role would never actually be
 * removed. The two authorities are alternatives, never additive.
 *
 * ## Why this reads the database on every request
 *
 * Because the Product Owner requires role and permission changes to take effect on
 * the next validated request, and forbids depending on process-local cache state
 * for authorization correctness. One indexed read per permission-gated route is
 * the price of that guarantee; it is not cached, deliberately.
 */
@Injectable()
export class PermissionResolver {
  private readonly logger = new Logger(PermissionResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthenticatedUser): Promise<ResolvedAuthority> {
    // Scoped by BOTH id and tenantId. A role id from another tenant must not
    // resolve even if the caller somehow set it — the query, not a later
    // comparison, is what makes a cross-tenant link impossible to use.
    const row = await this.prisma.user.findFirst({
      where: { id: user.id, tenantId: user.tenantId, isActive: true },
      select: {
        roleId: true,
        role: true,
        customRole: {
          select: {
            id: true,
            key: true,
            name: true,
            tenantId: true,
            isActive: true,
            permissions: { select: { key: true } },
          },
        },
      },
    });

    if (!row) {
      // Deactivated or removed between token issue and this request. The token is
      // still cryptographically valid; the account is not.
      return { source: 'DENIED', permissions: new Set(), reason: 'user-not-active' };
    }

    if (!row.roleId) {
      return {
        source: 'LEGACY_FALLBACK',
        permissions: new Set(ROLE_PERMISSIONS[row.role] as readonly Permission[]),
      };
    }

    if (!row.customRole) {
      this.logger.warn(
        `User ${user.id} references role ${row.roleId}, which does not resolve within ` +
          `tenant ${user.tenantId}. Denying — a broken role link must not fall back to the ` +
          'legacy authority, or deleting a role would restore permissions it removed.',
      );
      return { source: 'DENIED', permissions: new Set(), reason: 'role-unresolved' };
    }

    // Defence in depth: the relation is already tenant-scoped by the query above,
    // so this can only fire if that changes. It fails closed and says so loudly.
    if (row.customRole.tenantId !== user.tenantId) {
      this.logger.error(
        `Role ${row.customRole.id} belongs to tenant ${row.customRole.tenantId} but is ` +
          `assigned to a user in ${user.tenantId}. Denying.`,
      );
      return { source: 'DENIED', permissions: new Set(), reason: 'cross-tenant-role' };
    }

    // An archived role fails closed rather than reverting to legacy. Archival is a
    // deliberate revocation; restoring the enum's permissions would undo it. The
    // API refuses to archive a role that still has users, so reaching this state
    // means the assignment was made outside the application.
    if (!row.customRole.isActive) {
      this.logger.warn(
        `User ${user.id} holds archived role ${row.customRole.key ?? row.customRole.id}. Denying.`,
      );
      return { source: 'DENIED', permissions: new Set(), reason: 'role-archived' };
    }

    const assigned = row.customRole.permissions.map((p) => p.key);
    const unknown = assigned.filter((key) => !CATALOGUE.has(key));
    if (unknown.length > 0) {
      // D37: the code catalogue is the authority on what may exist. A row naming
      // something outside it is a database someone has edited by hand, and
      // guessing which half to honour is worse than refusing.
      this.logger.error(
        `Role ${row.customRole.key ?? row.customRole.id} in tenant ${user.tenantId} assigns ` +
          `unknown permissions: ${unknown.join(', ')}. Denying.`,
      );
      return { source: 'DENIED', permissions: new Set(), reason: 'unknown-permission' };
    }

    return {
      source: 'DATABASE',
      permissions: new Set(assigned as Permission[]),
      roleName: row.customRole.name,
    };
  }
}
