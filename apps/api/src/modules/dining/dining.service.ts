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
  AreaNameTakenError,
  AreaNotFoundError,
  BranchNotFoundError,
  TableCodeTakenError,
  TableNotFoundError,
} from './dining.errors';

export interface DiningAreaView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
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
}

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
    dto: CreateDiningAreaDto,
  ): Promise<DiningAreaView> {
    await this.assertBranch(tenantId, branchId);
    try {
      const created = await this.prisma.diningArea.create({
        data: {
          tenantId,
          branchId,
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
    dto: UpdateDiningAreaDto,
  ): Promise<DiningAreaView> {
    const existing = await this.prisma.diningArea.findFirst({
      where: { id: areaId, tenantId, branchId },
      select: { id: true, name: true },
    });
    if (!existing) throw new AreaNotFoundError();
    try {
      const updated = await this.prisma.diningArea.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          position: dto.position ?? undefined,
          isActive: dto.isActive ?? undefined,
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
    dto: UpdateTableDto,
  ): Promise<RestaurantTableView> {
    const existing = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, tenantId, areaId },
      select: { id: true },
    });
    if (!existing) throw new TableNotFoundError();
    const updated = await this.prisma.restaurantTable.update({
      where: { id: existing.id },
      data: {
        label: dto.label !== undefined ? dto.label : undefined,
        capacity: dto.capacity ?? undefined,
        positionX: dto.positionX !== undefined ? dto.positionX : undefined,
        positionY: dto.positionY !== undefined ? dto.positionY : undefined,
        isActive: dto.isActive ?? undefined,
        status: dto.status ? (dto.status as RestaurantTableStatus) : undefined,
      },
    });
    return this.tableToView(updated);
  }

  // ── Assertions ──────────────────────────────────────────────
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
    };
  }
}
