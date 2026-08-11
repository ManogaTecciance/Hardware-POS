import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateModifierGroupDto, UpdateModifierGroupDto } from './dto/menu.dto';
import {
  ModifierGroupInvalidRangeError,
  ModifierGroupNameTakenError,
  ModifierGroupNotFoundError,
} from './menu.errors';

export interface ModifierOptionView {
  id: string;
  name: string;
  priceDelta: string;
  position: number;
  isActive: boolean;
}

export interface ModifierGroupView {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  isActive: boolean;
  options: ModifierOptionView[];
  /**
   * Wizard-only marker — 'SIZE' for a Small/Medium/Large group, null for a
   * plain modifier group. Server ignores it; the Menu wizard uses it to
   * re-open a saved item into the correct step.
   */
  role: string | null;
}

@Injectable()
export class ModifiersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, includeArchived = false): Promise<ModifierGroupView[]> {
    const rows = await this.prisma.modifierGroup.findMany({
      where: { tenantId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
    });
    return rows.map(this.toView);
  }

  async get(tenantId: string, groupId: string): Promise<ModifierGroupView> {
    const row = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, tenantId },
      include: { options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
    });
    if (!row) throw new ModifierGroupNotFoundError();
    return this.toView(row);
  }

  async create(tenantId: string, dto: CreateModifierGroupDto): Promise<ModifierGroupView> {
    this.assertRange(dto.selection ?? 'SINGLE', dto.minSelections, dto.maxSelections);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const group = await tx.modifierGroup.create({
          data: {
            tenantId,
            name: dto.name,
            selection: (dto.selection ?? 'SINGLE') as 'SINGLE' | 'MULTIPLE',
            minSelections: dto.minSelections ?? 0,
            maxSelections: dto.maxSelections ?? 1,
            role: dto.role ?? null,
          },
        });
        await tx.modifierOption.createMany({
          data: dto.options.map((o, i) => ({
            tenantId,
            groupId: group.id,
            name: o.name,
            priceDelta: new Prisma.Decimal(o.priceDelta ?? 0),
            position: o.position ?? i,
          })),
        });
        return group.id;
      });
      return this.get(tenantId, created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ModifierGroupNameTakenError(dto.name);
      }
      throw e;
    }
  }

  async update(
    tenantId: string,
    groupId: string,
    dto: UpdateModifierGroupDto,
  ): Promise<ModifierGroupView> {
    const existing = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, tenantId },
      select: {
        id: true,
        selection: true,
        minSelections: true,
        maxSelections: true,
        name: true,
      },
    });
    if (!existing) throw new ModifierGroupNotFoundError();
    this.assertRange(
      dto.selection ?? existing.selection,
      dto.minSelections ?? existing.minSelections,
      dto.maxSelections ?? existing.maxSelections,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.modifierGroup.update({
          where: { id: existing.id },
          data: {
            name: dto.name ?? undefined,
            selection: (dto.selection ?? undefined) as 'SINGLE' | 'MULTIPLE' | undefined,
            minSelections: dto.minSelections ?? undefined,
            maxSelections: dto.maxSelections ?? undefined,
            isActive: dto.isActive ?? undefined,
            role: dto.role !== undefined ? dto.role : undefined,
          },
        });
        if (dto.options) {
          await tx.modifierOption.deleteMany({ where: { groupId: existing.id } });
          if (dto.options.length) {
            await tx.modifierOption.createMany({
              data: dto.options.map((o, i) => ({
                tenantId,
                groupId: existing.id,
                name: o.name,
                priceDelta: new Prisma.Decimal(o.priceDelta ?? 0),
                position: o.position ?? i,
              })),
            });
          }
        }
      });
      return this.get(tenantId, existing.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ModifierGroupNameTakenError(dto.name ?? existing.name);
      }
      throw e;
    }
  }

  private assertRange(selection: string, min?: number, max?: number): void {
    const s = selection ?? 'SINGLE';
    const lo = min ?? 0;
    const hi = max ?? 1;
    if (lo > hi) throw new ModifierGroupInvalidRangeError();
    if (s === 'SINGLE' && hi !== 1) throw new ModifierGroupInvalidRangeError();
  }

  private toView(
    row: Prisma.ModifierGroupGetPayload<{ include: { options: true } }>,
  ): ModifierGroupView {
    return {
      id: row.id,
      name: row.name,
      selection: row.selection,
      minSelections: row.minSelections,
      maxSelections: row.maxSelections,
      isActive: row.isActive,
      options: row.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDelta: o.priceDelta.toFixed(2),
        position: o.position,
        isActive: o.isActive,
      })),
      role: row.role,
    };
  }
}
