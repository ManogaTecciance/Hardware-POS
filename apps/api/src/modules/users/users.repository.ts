import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/** Fields safe to return to clients (never expose pinHash). */
const publicUserSelect = {
  id: true,
  tenantId: true,
  branchId: true,
  role: true,
  name: true,
  email: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManyByTenant(
    tenantId: string,
    skip: number,
    take: number,
  ): Promise<[PublicUser[], number]> {
    return this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { tenantId },
        select: publicUserSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.user.count({ where: { tenantId } }),
    ]);
  }

  findByIdForTenant(tenantId: string, id: string): Promise<PublicUser | null> {
    return this.prisma.user.findFirst({
      where: { id, tenantId },
      select: publicUserSelect,
    });
  }

  async listBranchAccess(
    tenantId: string,
    userId: string,
  ): Promise<{ branchId: string; grantedAt: string; grantedByUserId: string | null }[]> {
    const rows = await this.prisma.branchAccess.findMany({
      where: { userId, branch: { tenantId } },
      orderBy: { grantedAt: 'asc' },
      select: { branchId: true, grantedAt: true, grantedByUserId: true },
    });
    return rows.map((r) => ({
      branchId: r.branchId,
      grantedAt: r.grantedAt.toISOString(),
      grantedByUserId: r.grantedByUserId,
    }));
  }

  findActiveBranchForTenant(tenantId: string, branchId: string): Promise<{ id: string } | null> {
    return this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
  }

  async upsertBranchAccess(
    userId: string,
    branchId: string,
    grantedByUserId: string,
  ): Promise<void> {
    await this.prisma.branchAccess.upsert({
      where: { userId_branchId: { userId, branchId } },
      // Grant is idempotent; a re-grant does not reset `grantedAt` because the
      // audit answer to "when did this user first get access" would then move
      // every time an administrator re-confirmed. The grantor is likewise not
      // overwritten on a no-op.
      update: {},
      create: { userId, branchId, grantedByUserId },
    });
  }

  async branchAccessExists(userId: string, branchId: string): Promise<boolean> {
    const row = await this.prisma.branchAccess.findUnique({
      where: { userId_branchId: { userId, branchId } },
      select: { id: true },
    });
    return row !== null;
  }

  async deleteBranchAccess(userId: string, branchId: string): Promise<boolean> {
    const result = await this.prisma.branchAccess.deleteMany({
      where: { userId, branchId },
    });
    return result.count > 0;
  }

  /**
   * How many active branches this user could still reach if the given
   * `branchId` grant is revoked. `User.branchId` counts too — it is the
   * pre-1.5.6 default and revoking every explicit grant should not lock out
   * a user whose default branch is still assigned.
   */
  async countRemainingBranches(
    userId: string,
    branchIdBeingRevoked: string,
    defaultBranchId: string | null,
  ): Promise<number> {
    const explicit = await this.prisma.branchAccess.count({
      where: {
        userId,
        branchId: { not: branchIdBeingRevoked },
        branch: { isActive: true },
      },
    });
    const defaultCounts =
      defaultBranchId && defaultBranchId !== branchIdBeingRevoked ? 1 : 0;
    return explicit + defaultCounts;
  }
}
