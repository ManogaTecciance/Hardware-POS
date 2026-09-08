import { Injectable } from '@nestjs/common';
import { Prisma, RestaurantTableKind, RestaurantTableStatus } from '@hardware-pos/database';

import { nextDocumentNumber } from '../../common/document-sequence';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateDiningAreaDto,
  CreateOpenTableDto,
  CreateTableDto,
  UpdateDiningAreaDto,
  UpdateTableDto,
} from './dto/dining.dto';
import {
  AreaHasActiveTablesError,
  AreaNameTakenError,
  AreaNotFoundError,
  BranchNotFoundError,
  ForbiddenNotCreatorError,
  MemberTableUnavailableError,
  OpenTableInServiceError,
  OpenTableNotFoundError,
  TableNotHeldByOpenTableError,
  TableCodeTakenError,
  TableInServiceError,
  TableNotFoundError,
} from './dining.errors';

export interface DiningAreaView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
  /** The user who created this area. Null only on legacy rows the migration could not attribute. */
  createdByUserId: string | null;
}

export interface RestaurantTableView {
  id: string;
  /** Null only for kind=OPEN — ad-hoc tables belong to no floor area (D49). */
  areaId: string | null;
  branchId: string;
  kind: RestaurantTableKind;
  code: string;
  label: string | null;
  /** Null only for kind=OPEN with no recorded seats (D49). */
  capacity: number | null;
  positionX: number | null;
  positionY: number | null;
  status: RestaurantTableStatus;
  isActive: boolean;
  createdByUserId: string | null;
}

/**
 * D50 — what a close/dissolve did to the arrangement's physical tables.
 *
 * `released` went back to AVAILABLE because this was their LAST open-table
 * membership. `stillReserved` are still held by another open table, and carry
 * who holds them — that list is what the billing reminder is built from.
 */
export interface OpenTableReleaseSummary {
  released: Array<{ id: string; code: string; label: string | null }>;
  stillReserved: Array<{
    id: string;
    code: string;
    label: string | null;
    heldBy: Array<{ id: string; code: string; label: string | null }>;
  }>;
}

/** D49 — an open table plus the physical tables it absorbed. */
export interface OpenTableView extends RestaurantTableView {
  members: Array<{
    id: string;
    code: string;
    label: string | null;
    areaId: string | null;
    status: RestaurantTableStatus;
  }>;
}

/**
 * Sessions the archive check treats as "in service". Explicit list, not
 * `!= CLOSED`, so a new status added later must be classified deliberately —
 * silently defaulting to "not in service" would let an unfinished session
 * bypass the archive block.
 */
const IN_SERVICE_SESSION_STATUSES: Prisma.TableSessionWhereInput['status'] = {
  in: ['OPEN', 'BILLING'],
};

@Injectable()
export class DiningService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Areas ──────────────────────────────────────────────────
  async listAreas(tenantId: string, branchId: string, includeArchived = false): Promise<DiningAreaView[]> {
    await this.assertBranch(tenantId, branchId);
    const rows = await this.prisma.diningArea.findMany({
      where: { tenantId, branchId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(this.areaToView);
  }

  async createArea(
    tenantId: string,
    branchId: string,
    actorUserId: string,
    dto: CreateDiningAreaDto,
  ): Promise<DiningAreaView> {
    await this.assertBranch(tenantId, branchId);
    try {
      const created = await this.prisma.diningArea.create({
        data: {
          tenantId,
          branchId,
          // Creator comes from the authenticated actor, never the DTO — the DTO
          // shape does not expose the field for exactly this reason, but the
          // explicit assignment here is the belt to the DTO's braces.
          createdByUserId: actorUserId,
          name: dto.name,
          description: dto.description ?? null,
          position: dto.position ?? 0,
        },
      });
      return this.areaToView(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AreaNameTakenError(dto.name);
      }
      throw e;
    }
  }

  async updateArea(
    tenantId: string,
    branchId: string,
    areaId: string,
    actorUserId: string,
    dto: UpdateDiningAreaDto,
  ): Promise<DiningAreaView> {
    const existing = await this.findOwnedArea(tenantId, branchId, areaId, actorUserId);
    // The service is intentionally strict about the fields update can touch —
    // it will never flip `isActive`, since that is the archive path and has
    // its own conflict checks. A DTO carrying `isActive: false` here would
    // silently bypass those checks. Ignore it deliberately.
    try {
      const updated = await this.prisma.diningArea.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          position: dto.position ?? undefined,
          // Deliberately drops `dto.isActive` — see archiveArea below.
        },
      });
      return this.areaToView(updated);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AreaNameTakenError(dto.name ?? existing.name);
      }
      throw e;
    }
  }

  async archiveArea(
    tenantId: string,
    branchId: string,
    areaId: string,
    actorUserId: string,
  ): Promise<DiningAreaView> {
    const existing = await this.findOwnedArea(tenantId, branchId, areaId, actorUserId);
    // Guard: an area with any non-archived tables must be cleared first. The
    // count is what the operator needs to act on — not the identifiers.
    const activeTables = await this.prisma.restaurantTable.count({
      where: { areaId: existing.id, tenantId, isActive: true },
    });
    if (activeTables > 0) {
      throw new AreaHasActiveTablesError(activeTables);
    }
    const updated = await this.prisma.diningArea.update({
      where: { id: existing.id },
      data: { isActive: false },
    });
    return this.areaToView(updated);
  }

  // ── Tables ─────────────────────────────────────────────────
  async listTables(tenantId: string, areaId: string, includeArchived = false): Promise<RestaurantTableView[]> {
    await this.assertArea(tenantId, areaId);
    const rows = await this.prisma.restaurantTable.findMany({
      where: { tenantId, areaId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: { code: 'asc' },
    });
    return rows.map(this.tableToView);
  }

  async createTable(
    tenantId: string,
    areaId: string,
    actorUserId: string,
    dto: CreateTableDto,
  ): Promise<RestaurantTableView> {
    const area = await this.prisma.diningArea.findFirst({
      where: { id: areaId, tenantId, isActive: true },
      select: { id: true, branchId: true },
    });
    if (!area) throw new AreaNotFoundError();
    try {
      const created = await this.prisma.restaurantTable.create({
        data: {
          tenantId,
          branchId: area.branchId,
          areaId: area.id,
          createdByUserId: actorUserId,
          code: dto.code,
          label: dto.label ?? null,
          capacity: dto.capacity,
          positionX: dto.positionX ?? null,
          positionY: dto.positionY ?? null,
        },
      });
      return this.tableToView(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new TableCodeTakenError(dto.code);
      }
      throw e;
    }
  }

  async updateTable(
    tenantId: string,
    areaId: string,
    tableId: string,
    actorUserId: string,
    dto: UpdateTableDto,
  ): Promise<RestaurantTableView> {
    const existing = await this.findOwnedTable(tenantId, areaId, tableId, actorUserId);
    // Same posture as areas: `isActive` and `status` do not travel through the
    // creator-scoped edit path. Status is an operational field driven by the
    // sessions system; archive has its own route with its own conflict rules.
    const updated = await this.prisma.restaurantTable.update({
      where: { id: existing.id },
      data: {
        label: dto.label !== undefined ? dto.label : undefined,
        capacity: dto.capacity ?? undefined,
        positionX: dto.positionX !== undefined ? dto.positionX : undefined,
        positionY: dto.positionY !== undefined ? dto.positionY : undefined,
      },
    });
    return this.tableToView(updated);
  }

  async archiveTable(
    tenantId: string,
    areaId: string,
    tableId: string,
    actorUserId: string,
  ): Promise<RestaurantTableView> {
    const existing = await this.findOwnedTable(tenantId, areaId, tableId, actorUserId);
    const activeSessions = await this.prisma.tableSession.count({
      where: { tableId: existing.id, status: IN_SERVICE_SESSION_STATUSES },
    });
    if (activeSessions > 0) {
      throw new TableInServiceError();
    }
    // D49: a table absorbed into an open table is in service by proxy —
    // archiving it mid-arrangement would strand the membership row and
    // resurrect the table as AVAILABLE underneath a seated party.
    const membership = await this.prisma.openTableMember.count({
      where: { memberTableId: existing.id },
    });
    if (membership > 0) {
      throw new TableInServiceError();
    }
    const updated = await this.prisma.restaurantTable.update({
      where: { id: existing.id },
      data: { isActive: false, status: 'AVAILABLE' },
    });
    return this.tableToView(updated);
  }

  /**
   * Operational status update — never routed through the creator-scoped edit
   * path. Called by table-sessions/orders when open/seat/close moves a table.
   * Kept as a distinct method so a future audit of "who can flip status" does
   * not accidentally look at the ownership rules for a floor-plan edit.
   */
  async setTableStatus(
    tenantId: string,
    tableId: string,
    status: RestaurantTableStatus,
  ): Promise<RestaurantTableView> {
    const existing = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, tenantId },
      select: { id: true },
    });
    if (!existing) throw new TableNotFoundError();
    const updated = await this.prisma.restaurantTable.update({
      where: { id: existing.id },
      data: { status },
    });
    return this.tableToView(updated);
  }

  // ── Open tables (D49) ───────────────────────────────────────

  async listOpenTables(tenantId: string, branchId: string): Promise<OpenTableView[]> {
    await this.assertBranch(tenantId, branchId);
    const rows = await this.prisma.restaurantTable.findMany({
      where: { tenantId, branchId, kind: RestaurantTableKind.OPEN, isActive: true },
      include: {
        openMembers: {
          include: {
            memberTable: {
              select: { id: true, code: true, label: true, areaId: true, status: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      ...this.tableToView(row),
      members: row.openMembers.map((m) => m.memberTable),
    }));
  }

  /**
   * Join physical tables into a named open table (D49). Members go RESERVED
   * inside the same transaction that creates the arrangement; the FOR UPDATE
   * lock serialises two clerks grabbing the same table, and the
   * OpenTableMember.memberTableId unique is the structural backstop.
   */
  async createOpenTable(
    tenantId: string,
    branchId: string,
    actorUserId: string,
    dto: CreateOpenTableDto,
  ): Promise<OpenTableView> {
    await this.assertBranch(tenantId, branchId);
    const memberIds = [...new Set(dto.memberTableIds)];

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RestaurantTable" WHERE id IN (${Prisma.join(memberIds)}) FOR UPDATE`;
      const members = await tx.restaurantTable.findMany({
        where: { id: { in: memberIds }, tenantId, branchId },
        select: { id: true, code: true, status: true, isActive: true, kind: true },
      });
      // A requested id that resolved to nothing in this tenant/branch is a 404,
      // not a conflict — nothing to name without leaking another tenant's rows.
      if (members.length !== memberIds.length) throw new TableNotFoundError();
      for (const member of members) {
        // D50: RESERVED joins AVAILABLE as an eligible status — one physical
        // table may back several open tables (two unrelated parties sharing a
        // four-top). Everything else is still refused: a table with a party
        // physically at it is not shareable, and an OPEN table is not a member.
        const joinable =
          member.isActive &&
          member.kind === RestaurantTableKind.PHYSICAL &&
          (member.status === RestaurantTableStatus.AVAILABLE ||
            member.status === RestaurantTableStatus.RESERVED);
        if (!joinable) throw new MemberTableUnavailableError(member.code);
      }

      const sequence = await nextDocumentNumber(tx, tenantId, 'OPEN_TABLE');
      const openTable = await tx.restaurantTable.create({
        data: {
          tenantId,
          branchId,
          areaId: null,
          kind: RestaurantTableKind.OPEN,
          code: `OPEN-${sequence}`,
          label: dto.name.trim(),
          capacity: dto.seats ?? null,
          createdByUserId: actorUserId,
        },
      });
      await tx.openTableMember.createMany({
        data: memberIds.map((memberTableId) => ({ tenantId, openTableId: openTable.id, memberTableId })),
      });
      await tx.restaurantTable.updateMany({
        where: { id: { in: memberIds } },
        data: { status: RestaurantTableStatus.RESERVED },
      });
      return openTable;
    });

    const [view] = await this.listOpenTablesById(tenantId, created.id);
    return view;
  }

  /** Manual dissolve — the party never sat down. Refuses a live session. */
  async dissolveOpenTable(
    tenantId: string,
    branchId: string,
    openTableId: string,
  ): Promise<OpenTableView & { release: OpenTableReleaseSummary }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.restaurantTable.findFirst({
        where: {
          id: openTableId,
          tenantId,
          branchId,
          kind: RestaurantTableKind.OPEN,
          isActive: true,
        },
        include: {
          openMembers: {
            include: {
              memberTable: {
                select: { id: true, code: true, label: true, areaId: true, status: true },
              },
            },
          },
        },
      });
      if (!row) throw new OpenTableNotFoundError();
      const liveSession = await tx.tableSession.findFirst({
        where: { tableId: row.id, status: IN_SERVICE_SESSION_STATUSES },
        select: { id: true },
      });
      if (liveSession) throw new OpenTableInServiceError();

      const release = await this.releaseOpenTable(tx, tenantId, row.id);
      // D50: members are NOT uniformly AVAILABLE any more — one still held by
      // another open table stays RESERVED. Report each member's real status.
      const releasedIds = new Set(release.released.map((t) => t.id));
      return {
        ...this.tableToView({ ...row, isActive: false, status: RestaurantTableStatus.AVAILABLE }),
        members: row.openMembers.map((m) => ({
          ...m.memberTable,
          status: releasedIds.has(m.memberTable.id)
            ? RestaurantTableStatus.AVAILABLE
            : RestaurantTableStatus.RESERVED,
        })),
        release,
      };
    });
  }

  /**
   * The release half of the lifecycle, shared between manual dissolve and the
   * automatic bill-close hook (table-sessions.service). Runs inside the
   * CALLER's transaction so "bill closed" and "members released" cannot be
   * observed apart.
   *
   * D50 — last one out. This open table's own memberships go and its row is
   * archived, but a member returns to AVAILABLE only when NO live membership
   * remains: two parties sharing a four-top each hold it, and the first bill
   * to close must not free it under the second party. Members still held are
   * reported back so billing can remind the operator to check them.
   */
  async releaseOpenTable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    openTableId: string,
  ): Promise<OpenTableReleaseSummary> {
    const memberIds = (
      await tx.openTableMember.findMany({
        where: { openTableId, tenantId },
        select: { memberTableId: true },
      })
    ).map((m) => m.memberTableId);

    await tx.openTableMember.deleteMany({ where: { openTableId, tenantId } });
    await tx.restaurantTable.update({
      where: { id: openTableId },
      data: { isActive: false, status: RestaurantTableStatus.AVAILABLE },
    });
    if (memberIds.length === 0) return { released: [], stillReserved: [] };

    // Who still holds each former member? Filtered on the holder being live so
    // a stale membership could never keep a table hostage.
    const remaining = await tx.openTableMember.findMany({
      where: {
        tenantId,
        memberTableId: { in: memberIds },
        openTable: { isActive: true },
      },
      select: {
        memberTableId: true,
        openTable: { select: { id: true, code: true, label: true } },
      },
    });
    const holdersByMember = new Map<string, Array<{ id: string; code: string; label: string | null }>>();
    for (const row of remaining) {
      const list = holdersByMember.get(row.memberTableId) ?? [];
      list.push(row.openTable);
      holdersByMember.set(row.memberTableId, list);
    }

    const releasableIds = memberIds.filter((id) => !holdersByMember.has(id));
    if (releasableIds.length > 0) {
      await tx.restaurantTable.updateMany({
        where: { id: { in: releasableIds } },
        data: { status: RestaurantTableStatus.AVAILABLE },
      });
    }

    const rows = await tx.restaurantTable.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, code: true, label: true },
      orderBy: { code: 'asc' },
    });
    return {
      released: rows.filter((r) => !holdersByMember.has(r.id)),
      stillReserved: rows
        .filter((r) => holdersByMember.has(r.id))
        .map((r) => ({ ...r, heldBy: holdersByMember.get(r.id) ?? [] })),
    };
  }

  /**
   * D50 — manual early release of ONE physical table from every open table
   * holding it.
   *
   * The escape hatch for compaction: two parties of three shared a four-top
   * and a two-top; the first is billed, and the remaining three now fit on the
   * four-top alone. Only a human can know that, so the server never does it on
   * its own. Deliberately permitted even when this strips the last member of a
   * live open table — refusing would invent a rule that blocks a real
   * compaction, and the server cannot see the room.
   */
  async releaseMemberTable(
    tenantId: string,
    branchId: string,
    tableId: string,
  ): Promise<{ table: RestaurantTableView; releasedFrom: Array<{ id: string; code: string; label: string | null }> }> {
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.restaurantTable.findFirst({
        where: {
          id: tableId,
          tenantId,
          branchId,
          isActive: true,
          kind: RestaurantTableKind.PHYSICAL,
        },
      });
      if (!table) throw new TableNotFoundError();

      const memberships = await tx.openTableMember.findMany({
        where: { memberTableId: table.id, tenantId, openTable: { isActive: true } },
        select: { id: true, openTable: { select: { id: true, code: true, label: true } } },
      });
      // Refused rather than silently flipping the status: this is exactly the
      // failure the PO named — an operator must never be able to "unreserve" a
      // table that no open table is holding.
      if (memberships.length === 0) throw new TableNotHeldByOpenTableError();

      const ownSession = await tx.tableSession.findFirst({
        where: { tableId: table.id, status: IN_SERVICE_SESSION_STATUSES },
        select: { id: true },
      });
      if (ownSession) throw new TableInServiceError();

      await tx.openTableMember.deleteMany({
        where: { id: { in: memberships.map((m) => m.id) } },
      });
      const updated = await tx.restaurantTable.update({
        where: { id: table.id },
        data: { status: RestaurantTableStatus.AVAILABLE },
      });
      return {
        table: this.tableToView(updated),
        releasedFrom: memberships.map((m) => m.openTable),
      };
    });
  }

  private async listOpenTablesById(tenantId: string, id: string): Promise<OpenTableView[]> {
    const rows = await this.prisma.restaurantTable.findMany({
      where: { id, tenantId },
      include: {
        openMembers: {
          include: {
            memberTable: {
              select: { id: true, code: true, label: true, areaId: true, status: true },
            },
          },
        },
      },
    });
    return rows.map((row) => ({
      ...this.tableToView(row),
      members: row.openMembers.map((m) => m.memberTable),
    }));
  }

  // ── Ownership + tenant scoping ──────────────────────────────
  private async findOwnedArea(
    tenantId: string,
    branchId: string,
    areaId: string,
    actorUserId: string,
  ) {
    const row = await this.prisma.diningArea.findFirst({
      where: { id: areaId, tenantId, branchId },
      select: { id: true, name: true, createdByUserId: true },
    });
    // Both "no such row in this tenant" and "row belongs to another creator"
    // return the same generic 403 to callers. Enumeration protection is the
    // reason — a caller probing for tenant-crossing ids must not be able to
    // distinguish these two cases from the response alone.
    if (!row) throw new ForbiddenNotCreatorError('dining area');
    if (row.createdByUserId !== actorUserId) throw new ForbiddenNotCreatorError('dining area');
    return row;
  }

  private async findOwnedTable(
    tenantId: string,
    areaId: string,
    tableId: string,
    actorUserId: string,
  ) {
    const row = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, tenantId, areaId },
      select: { id: true, createdByUserId: true },
    });
    if (!row) throw new ForbiddenNotCreatorError('table');
    if (row.createdByUserId !== actorUserId) throw new ForbiddenNotCreatorError('table');
    return row;
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const b = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!b) throw new BranchNotFoundError();
  }

  private async assertArea(tenantId: string, areaId: string): Promise<void> {
    const a = await this.prisma.diningArea.findFirst({
      where: { id: areaId, tenantId },
      select: { id: true },
    });
    if (!a) throw new AreaNotFoundError();
  }

  private areaToView(row: Prisma.DiningAreaGetPayload<Record<string, never>>): DiningAreaView {
    return {
      id: row.id,
      branchId: row.branchId,
      name: row.name,
      description: row.description,
      position: row.position,
      isActive: row.isActive,
      createdByUserId: row.createdByUserId,
    };
  }

  private tableToView(row: Prisma.RestaurantTableGetPayload<Record<string, never>>): RestaurantTableView {
    return {
      id: row.id,
      areaId: row.areaId,
      branchId: row.branchId,
      kind: row.kind,
      code: row.code,
      label: row.label,
      capacity: row.capacity,
      positionX: row.positionX,
      positionY: row.positionY,
      status: row.status,
      isActive: row.isActive,
      createdByUserId: row.createdByUserId,
    };
  }
}
