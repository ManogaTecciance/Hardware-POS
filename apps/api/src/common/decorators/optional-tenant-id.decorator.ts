import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../modules/auth/auth.types';

/**
 * Resolves the current tenant id, or `null` when none can be determined.
 *
 * Deliberately separate from {@link TenantId}, which throws when the tenant is
 * unresolvable — that is correct on the ~20 authenticated controllers using it,
 * and this must not change their behaviour.
 *
 * The one place this is needed is email + password login: the tenant is not known
 * before authentication, and requiring a header would break every existing
 * single-tenant client.
 *
 * SECURITY — the value returned here is CLIENT-SUPPLIED and must never be trusted
 * on its own. It is only ever a *narrowing hint*: the caller still has to find a
 * real active user for `(tenantId, email)` and verify the password against that
 * user's own hash. A wrong or invented tenant id can therefore only ever cause a
 * login to fail, never to succeed against a tenant the credentials do not belong
 * to. Do not use this decorator to authorise anything.
 */
export const OptionalTenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    // A verified session always wins over anything the client asserted.
    if (request.user?.tenantId) {
      return request.user.tenantId;
    }

    const header = request.headers['x-tenant-id'];
    if (typeof header === 'string' && header.trim().length > 0) {
      return header.trim();
    }

    return null;
  },
);
