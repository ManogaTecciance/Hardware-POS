import { ForbiddenException, Injectable, NotFoundException, NotImplementedException } from '@nestjs/common';
import type { Paginated } from '@hardware-pos/shared';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { paginate } from '../../common/pagination';
import { CreateUserDto } from './dto/create-user.dto';
import { PublicUser, UsersRepository } from './users.repository';

export interface UserBranchAccessView {
  userId: string;
  role: string;
  /**
   * `true` when the user gains implicit access to every active branch of the
   * tenant through their role (OWNER/ADMIN). Under that flag the explicit
   * grants list is *supplementary* — the guard grants access through the
   * role, not through the rows.
   */
  roleGrant: boolean;
  /** The user's default branch — the branch chosen at login without a switch. */
  defaultBranchId: string | null;
  /** Every explicit `BranchAccess` row, oldest first. */
  explicitGrants: { branchId: string; grantedAt: string; grantedByUserId: string | null }[];
}

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async list(tenantId: string, query: PaginationQueryDto): Promise<Paginated<PublicUser>> {
    const [items, total] = await this.usersRepository.findManyByTenant(
      tenantId,
      query.skip,
      query.take,
    );
    return paginate(items, total, query.page, query.pageSize);
  }

  async getById(tenantId: string, id: string): Promise<PublicUser> {
    const user = await this.usersRepository.findByIdForTenant(tenantId, id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  /** TODO: hash the PIN, enforce role rules, and persist. */
  create(_tenantId: string, _dto: CreateUserDto): Promise<PublicUser> {
    throw new NotImplementedException('User creation is not implemented yet');
  }

  async listBranchAccess(tenantId: string, userId: string): Promise<UserBranchAccessView> {
    const user = await this.usersRepository.findByIdForTenant(tenantId, userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    const grants = await this.usersRepository.listBranchAccess(tenantId, userId);
    return {
      userId: user.id,
      role: user.role,
      roleGrant: user.role === 'OWNER' || user.role === 'ADMIN',
      defaultBranchId: user.branchId,
      explicitGrants: grants,
    };
  }

  async grantBranchAccess(
    tenantId: string,
    userId: string,
    branchId: string,
    grantedByUserId: string,
  ): Promise<UserBranchAccessView> {
    const user = await this.usersRepository.findByIdForTenant(tenantId, userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    // Foreign tenant ids answer 404, never 403 — a 403 would be a
    // cross-tenant existence oracle (matches the Phase 1.5.5 role rule).
    const branch = await this.usersRepository.findActiveBranchForTenant(tenantId, branchId);
    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found`);
    }
    await this.usersRepository.upsertBranchAccess(userId, branchId, grantedByUserId);
    return this.listBranchAccess(tenantId, userId);
  }

  async revokeBranchAccess(
    tenantId: string,
    userId: string,
    branchId: string,
  ): Promise<{ removed: boolean; view: UserBranchAccessView }> {
    const user = await this.usersRepository.findByIdForTenant(tenantId, userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    // Existence check first: a non-existent grant is a 404 regardless of
    // whether removing it would have caused a lockout, because "already
    // absent" is the same state the caller was asking for.
    const exists = await this.usersRepository.branchAccessExists(userId, branchId);
    if (!exists) {
      return { removed: false, view: await this.listBranchAccess(tenantId, userId) };
    }
    // Refuse to revoke the last branch a non-admin can reach. Owner and admin
    // gain access implicitly through their role, so revoking their explicit
    // grants never locks them out.
    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      const remaining = await this.usersRepository.countRemainingBranches(userId, branchId, user.branchId);
      if (remaining === 0) {
        throw new ForbiddenException(
          'Cannot revoke the last branch this user can access. Grant another branch first.',
        );
      }
    }
    const removed = await this.usersRepository.deleteBranchAccess(userId, branchId);
    return { removed, view: await this.listBranchAccess(tenantId, userId) };
  }
}
