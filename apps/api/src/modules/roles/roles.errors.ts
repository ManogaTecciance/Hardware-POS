import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Role-management failures (Phase 1.5.5).
 *
 * Each carries a machine-readable `code` so a client can branch on the outcome
 * without matching prose, matching `platform.errors.ts`.
 *
 * **A role in another tenant is a 404, never a 403.** Distinguishing "you may not
 * touch this role" from "no such role" tells the caller that a given id exists
 * somewhere in the system, which is a cross-tenant existence oracle. Both answer
 * the same way.
 */
export class RoleNotFoundError extends NotFoundException {
  constructor(roleId: string) {
    super({
      statusCode: 404,
      error: 'RoleError',
      code: 'ROLE_NOT_FOUND',
      message: `No role ${roleId} in this workspace.`,
    });
  }
}

export class BuiltInRoleImmutableError extends BadRequestException {
  constructor(what: string) {
    super({
      statusCode: 400,
      error: 'RoleError',
      code: 'ROLE_BUILT_IN_IMMUTABLE',
      message: `A built-in role cannot ${what}.`,
    });
  }
}

export class RoleArchivedError extends BadRequestException {
  constructor() {
    super({
      statusCode: 400,
      error: 'RoleError',
      code: 'ROLE_ARCHIVED',
      message: 'This role is archived and cannot be assigned or edited.',
    });
  }
}

export class RoleStillAssignedError extends ConflictException {
  constructor(count: number) {
    super({
      statusCode: 409,
      error: 'RoleError',
      code: 'ROLE_STILL_ASSIGNED',
      message: `Reassign the ${count} user(s) holding this role before archiving it.`,
    });
  }
}

export class UnknownPermissionError extends BadRequestException {
  constructor(keys: string[]) {
    super({
      statusCode: 400,
      error: 'RoleError',
      code: 'ROLE_UNKNOWN_PERMISSION',
      message: `Not permissions this system recognises: ${keys.join(', ')}.`,
    });
  }
}

export class RoleVersionConflictError extends ConflictException {
  constructor(expected: number, actual: number) {
    super({
      statusCode: 409,
      error: 'RoleError',
      code: 'ROLE_VERSION_CONFLICT',
      message: `This role changed while you were editing it (expected v${expected}, found v${actual}). Reload and try again.`,
    });
  }
}

/**
 * The lockout guard.
 *
 * A tenant that loses its last administrator cannot recover without support
 * intervention — there is no super-admin in this product. So the operation is
 * refused rather than completed and regretted.
 */
export class TenantAdministrationLockoutError extends ConflictException {
  constructor(detail: string) {
    super({
      statusCode: 409,
      error: 'RoleError',
      code: 'ROLE_LAST_ADMINISTRATOR',
      message: `${detail} A workspace must keep at least one active user who can manage users and roles.`,
    });
  }
}

export class RoleKeyTakenError extends ConflictException {
  constructor(key: string) {
    super({
      statusCode: 409,
      error: 'RoleError',
      code: 'ROLE_KEY_TAKEN',
      message: `A role with the key ${key} already exists in this workspace. Keys are never reused.`,
    });
  }
}
