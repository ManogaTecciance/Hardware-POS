import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../modules/auth/auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  BRANCH_SCOPE_METADATA,
  BranchScopeKind,
} from '../decorators/branch-scope.decorator';

/**
 * Phase 1.5.6 (decision D38).
 *
 * Global guard that runs after `PermissionsGuard`. It reads the route's
 * `@BranchScope(...)` metadata (defaulting to `TENANT_SCOPED`) and enforces:
 *
 *   TENANT_SCOPED    — no-op. The route does not act on a specific branch.
 *   BRANCH_SCOPED    — the caller must resolve to an active branch in their
 *                      tenant, and must currently have access to it. The
 *                      branch is taken from the token's `activeBranchId`
 *                      claim (Phase 1.5.6 tokens) or, as a compatibility
 *                      fallback for tokens issued before 1.5.6, from
 *                      `User.branchId`. Fail-closed on any deviation.
 *   REGISTER_SCOPED  — as `BRANCH_SCOPED`, plus a register check is deferred
 *                      to the controller (the register id is a body/param).
 *   GLOBAL_PLATFORM  — no-op. Health and public routes.
 *
 * Cross-tenant branches answer **404 branch not found**, never 403. A 403
 * would confirm the id exists somewhere, which is a cross-tenant existence
 * oracle (matches the Phase 1.5.5 rule for roles).
 *
 * The guard sets `request.effectiveBranchId` on the request when it resolves
 * a branch, so downstream services can read it without re-querying.
 */
@Injectable()
export class BranchScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const scope = this.reflector.getAllAndOverride<BranchScopeKind>(BRANCH_SCOPE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) ?? BranchScopeKind.TENANT_SCOPED;

    if (scope === BranchScopeKind.TENANT_SCOPED || scope === BranchScopeKind.GLOBAL_PLATFORM) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; effectiveBranchId?: string }>();
    const user = request.user;
    if (!user) {
      // JwtAuthGuard runs first; unauthenticated requests never reach us. If
      // one does, fail closed rather than trust upstream to always have thrown.
      throw new ForbiddenException('Branch scope requires an authenticated user');
    }

    const dbUser = await this.prisma.user.findFirst({
      where: { id: user.id, tenantId: user.tenantId, isActive: true },
      select: { id: true, role: true, branchId: true },
    });
    if (!dbUser) {
      throw new ForbiddenException('User is no longer active');
    }

    // Precedence: an explicit claim wins so that a caller that has switched
    // branches gets the branch they chose. Otherwise fall back to the user's
    // default branch (User.branchId) for backwards compatibility with tokens
    // issued before Phase 1.5.6.
    const candidateBranchId = user.activeBranchId ?? dbUser.branchId;
    if (!candidateBranchId) {
      throw new ForbiddenException('This request requires an active branch');
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: candidateBranchId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) {
      // Deactivated, deleted, or foreign. Always 404 — a 403 would leak that
      // the id exists somewhere.
      throw new NotFoundException('Branch not found');
    }

    const hasAccess =
      dbUser.role === 'OWNER' ||
      dbUser.role === 'ADMIN' ||
      dbUser.branchId === candidateBranchId ||
      (await this.prisma.branchAccess.findUnique({
        where: { userId_branchId: { userId: dbUser.id, branchId: candidateBranchId } },
        select: { id: true },
      })) !== null;

    if (!hasAccess) {
      // The user was removed from the branch — the token is stale, refuse
      // now. A new token must be minted with a permitted branch.
      throw new ForbiddenException('Access to this branch has been removed');
    }

    request.effectiveBranchId = candidateBranchId;
    return true;
  }
}
