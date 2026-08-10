import { Injectable } from '@nestjs/common';
import { Prisma, RestaurantTableStatus } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateDiningAreaDto,
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
  areaId: string;
  branchId: string;
  code: string;
  label: string | null;
  capacity: number;
  positionX: number | null;
  positionY: number | null;
  status: RestaurantTableStatus;
  isActive: boolean;
  createdByUserId: string | null;
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
