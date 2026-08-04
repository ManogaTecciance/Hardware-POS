import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

export type RefreshTokenWithUser = Prisma.RefreshTokenGetPayload<{ include: { user: true } }>;

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active users with this email, ACROSS ALL TENANTS, in a deterministic order.
   *
   * `User` is only `@@unique([tenantId, email])`, so one email may legitimately
   * exist in several tenants. This returns every candidate so the caller can
   * decide deterministically instead of silently taking whichever row PostgreSQL
   * happened to return first — the defect this replaces.
   *
   * Ordered by `tenantId` purely so repeated calls are stable and tests are not
   * flaky; the caller must never resolve ambiguity by picking the first row.
   */
  findActiveUsersByEmail(email: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { email, isActive: true },
      orderBy: { tenantId: 'asc' },
    });
  }

  /**
   * The single active user with this email inside one tenant. Exact by
   * construction: `@@unique([tenantId, email])` guarantees at most one row.
   */
  findActiveByTenantAndEmail(tenantId: string, email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { tenantId, email, isActive: true } });
  }

  /** Active users in a tenant that have a PIN set (for PIN login / approval). */
  findActivePinUsers(tenantId: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { tenantId, isActive: true, pinHash: { not: null } },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  // ── session location ─────────────────────────────────────────────────────

  /**
   * Resolve the branch + register a session operates at: the user's assigned
   * branch (or the tenant's first active branch for unassigned owners/admins)
   * and that branch's first active register.
   */
  async resolveLocation(
    tenantId: string,
    branchId: string | null,
  ): Promise<{
    branch: { id: string; name: string } | null;
    register: { id: string; name: string } | null;
  }> {
    const branch = branchId
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, tenantId, isActive: true },
          select: { id: true, name: true },
        })
      : await this.prisma.branch.findFirst({
          where: { tenantId, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        });
    if (!branch) return { branch: null, register: null };

    const register = await this.prisma.register.findFirst({
      where: { branchId: branch.id, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    return { branch, register };
  }

  // ── refresh tokens ─────────────────────────────────────────────────────

  async createRefreshToken(
    tenantId: string,
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.refreshToken.create({ data: { tenantId, userId, tokenHash, expiresAt } });
  }

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  async revokeRefreshToken(id: string): Promise<void> {
    await this.prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  /** Kill every live session for a user (used on refresh-token replay). */
  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Opportunistic cleanup of long-dead rows for a user. */
  async deleteExpiredRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });
  }
}
