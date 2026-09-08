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
  // D49 — open tables.
  OPEN_TABLE_NOT_FOUND: 'OPEN_TABLE_NOT_FOUND',
  OPEN_TABLE_MEMBER_UNAVAILABLE: 'OPEN_TABLE_MEMBER_UNAVAILABLE',
  OPEN_TABLE_IN_SERVICE: 'OPEN_TABLE_IN_SERVICE',
  TABLE_NOT_HELD_BY_OPEN_TABLE: 'TABLE_NOT_HELD_BY_OPEN_TABLE',
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

// ── D49 — open tables ────────────────────────────────────────

export class OpenTableNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.OPEN_TABLE_NOT_FOUND, 'Open table not found'));
  }
}

/**
 * Names the table code, not just "a table": the operator picked several and
 * needs to know which one was taken while the dialog was open.
 */
export class MemberTableUnavailableError extends ConflictException {
  constructor(code: string) {
    super(
      err(
        DINING_ERROR_CODES.OPEN_TABLE_MEMBER_UNAVAILABLE,
        `Table ${code} is not available to join — it is in service, archived, or already part of another open table`,
      ),
    );
  }
}

/** Refuses to dissolve an open table whose session is still live. */
export class OpenTableInServiceError extends ConflictException {
  constructor() {
    super(
      err(
        DINING_ERROR_CODES.OPEN_TABLE_IN_SERVICE,
        'This open table has a live session — close or settle its bill first.',
      ),
    );
  }
}

/**
 * D50. Refuses to "unreserve" a table that no open table is holding.
 *
 * This is the guard behind the PO's stated worry: the release action must
 * never be able to free a table that is RESERVED for some other reason. The
 * UI only offers it on held tables; this makes that a server rule rather than
 * a rendering accident.
 */
export class TableNotHeldByOpenTableError extends ConflictException {
  constructor() {
    super(
      err(
        DINING_ERROR_CODES.TABLE_NOT_HELD_BY_OPEN_TABLE,
        'This table is not held by an open table, so there is nothing to release.',
      ),
    );
  }
}
