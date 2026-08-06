import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateKitchenStationDto, UpdateKitchenStationDto } from './dto/kitchen-station.dto';
import {
  BranchNotFoundError,
  StationCodeTakenError,
  StationNotFoundError,
} from './restaurant.errors';

export interface KitchenStationView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class KitchenStationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, branchId: string, includeArchived = false): Promise<KitchenStationView[]> {
    await this.assertBranch(tenantId, branchId);
    const rows = await this.prisma.kitchenStation.findMany({
      where: {
        branchId,
        tenantId,
        ...(includeArchived ? {} : { isActive: true }),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(this.toView);
  }

  async get(tenantId: string, branchId: string, stationId: string): Promise<KitchenStationView> {
    const row = await this.prisma.kitchenStation.findFirst({
      where: { id: stationId, branchId, tenantId },
    });
    if (!row) throw new StationNotFoundError();
    return this.toView(row);
  }

  async create(
    tenantId: string,
    branchId: string,
    dto: CreateKitchenStationDto,
  ): Promise<KitchenStationView> {
    await this.assertBranch(tenantId, branchId);
    try {
      const created = await this.prisma.kitchenStation.create({
        data: {
          tenantId,
          branchId,
          code: dto.code,
          name: dto.name,
          category: dto.category ?? 'KITCHEN',
        },
      });
      return this.toView(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new StationCodeTakenError(dto.code);
      }
      throw err;
    }
  }

  async update(
    tenantId: string,
    branchId: string,
    stationId: string,
    dto: UpdateKitchenStationDto,
  ): Promise<KitchenStationView> {
    // Match on tenant+branch+id so a foreign id resolves 404, not a Prisma error.
    const existing = await this.prisma.kitchenStation.findFirst({
      where: { id: stationId, branchId, tenantId },
      select: { id: true },
    });
    if (!existing) throw new StationNotFoundError();
    const updated = await this.prisma.kitchenStation.update({
      where: { id: existing.id },
      data: {
        name: dto.name ?? undefined,
        category: dto.category ?? undefined,
        isActive: dto.isActive ?? undefined,
      },
    });
    return this.toView(updated);
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new BranchNotFoundError();
  }

  private toView(
    row: Prisma.KitchenStationGetPayload<Record<string, never>>,
  ): KitchenStationView {
    return {
      id: row.id,
      branchId: row.branchId,
      code: row.code,
      name: row.name,
      category: row.category,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
