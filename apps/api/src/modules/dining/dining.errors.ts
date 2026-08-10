import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

export const DINING_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  AREA_NOT_FOUND: 'AREA_NOT_FOUND',
  AREA_NAME_TAKEN: 'AREA_NAME_TAKEN',
  AREA_HAS_TABLES: 'AREA_HAS_TABLES',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  TABLE_CODE_TAKEN: 'TABLE_CODE_TAKEN',
  TABLE_STATUS_CONFLICT: 'TABLE_STATUS_CONFLICT',
  TABLE_IN_SERVICE: 'TABLE_IN_SERVICE',
  /** The caller is not the creator of this row. Message is deliberately generic. */
  FORBIDDEN_NOT_CREATOR: 'FORBIDDEN_NOT_CREATOR',
} as const;

const err = (code: string, message: string) => ({ code, message });

export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found'));
  }
}
export class AreaNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.AREA_NOT_FOUND, 'Dining area not found'));
  }
}
export class AreaNameTakenError extends ConflictException {
  constructor(name: string) {
    super(err(DINING_ERROR_CODES.AREA_NAME_TAKEN, `A dining area named "${name}" already exists on this branch`));
  }
}
export class TableNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.TABLE_NOT_FOUND, 'Table not found'));
  }
}
export class TableCodeTakenError extends ConflictException {
  constructor(code: string) {
    super(err(DINING_ERROR_CODES.TABLE_CODE_TAKEN, `Code "${code}" is already used in this dining area`));
  }
}

/**
 * Refuses to archive a Dining Area that still has non-archived tables. The
 * error names the count without leaking anything else: enumerating the tables
 * here would give an operator a shortcut, but it would also make the response
 * larger than the refusal warrants.
 */
export class AreaHasActiveTablesError extends ConflictException {
  constructor(activeCount: number) {
    super(
      err(
        DINING_ERROR_CODES.AREA_HAS_TABLES,
        `Move or archive the ${activeCount} active table${activeCount === 1 ? '' : 's'} in this dining area before archiving it.`,
      ),
    );
  }
}

/** Refuses to archive a Restaurant Table with an active session on it. */
export class TableInServiceError extends ConflictException {
  constructor() {
    super(
      err(
        DINING_ERROR_CODES.TABLE_IN_SERVICE,
        'This table is currently in service and cannot be archived.',
      ),
    );
  }
}

/**
 * Refuses a mutation because the caller is not the row's creator.
 *
 * The message is generic on purpose: it does not name the creator (another
 * user's identity is not the caller's business), and it does not distinguish
 * "you didn't create this" from "this row belongs to another tenant" — both
 * refusals present the same to the caller so a cross-tenant probe learns
 * nothing from the response body.
 */
export class ForbiddenNotCreatorError extends ForbiddenException {
  constructor(subject: 'dining area' | 'table') {
    super(
      err(
        DINING_ERROR_CODES.FORBIDDEN_NOT_CREATOR,
        `You can only edit ${subject === 'dining area' ? 'dining areas' : 'tables'} that you created.`,
      ),
    );
  }
}
