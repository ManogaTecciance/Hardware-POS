import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser, JwtPayload } from '../../modules/auth/auth.types';

/**
 * Global guard. Verifies the bearer token and attaches `request.user`. Routes
 * marked @Public() bypass it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = {
      id: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      // `activeBranchId` is context only. `BranchScopeGuard` re-validates it
      // against the database — a stale, forged or foreign branch is caught
      // there, not here. Tokens issued before Phase 1.5.6 have no claim and
      // resolve to `null`, which the guard treats as "tenant-wide by default".
      activeBranchId: payload.activeBranchId ?? null,
      // D55: carried on the token so PlatformBoundaryGuard can decide without
      // a database round trip on every request. It grants nothing on its own —
      // the flag only ever routes a request to a 403.
      isPlatformAdmin: payload.isPlatformAdmin === true,
    };
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }
    const [type, value] = header.split(' ');
    return type === 'Bearer' && value ? value : null;
  }
}
