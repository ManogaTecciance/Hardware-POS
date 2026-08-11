import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateItemDto, UpdateItemDto } from './dto/menu.dto';
import {
  ItemNotFoundError,
  ItemProductCrossTenantError,
  ModifierGroupNotFoundError,
  SectionNotFoundError,
  StationNotFoundError,
} from './menu.errors';

export interface MenuItemView {
  id: string;
  sectionId: string;
  name: string;
  description: string | null;
  basePrice: string;
  productId: string | null;
  isActive: boolean;
  position: number;
  modifierGroupIds: string[];
  stationIds: string[];
  channelPrices: { channel: string; price: string }[];
  availability: { dayOfWeek: string; startTime: string; endTime: string }[];
  createdAt: string;
  updatedAt: string;
  // Presentation fields — nullable for legacy rows created before the wizard.
  itemType: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null;
  prepMinutes: number | null;
  dietaryTags: string[];
  imageUrl: string | null;
}

@Injectable()
export class MenuItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, sectionId: string, includeArchived = false): Promise<MenuItemView[]> {
    await this.assertSection(tenantId, sectionId);
    const rows = await this.prisma.menuItem.findMany({
      where: { tenantId, sectionId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        modifierGroups: true,
        channelPrices: true,
        availability: true,
        stationLinks: true,
      },
    });
    return rows.map(this.toView);
  }

  async get(tenantId: string, itemId: string): Promise<MenuItemView> {
    const row = await this.prisma.menuItem.findFirst({
      where: { id: itemId, tenantId },
      include: {
        modifierGroups: true,
        channelPrices: true,
        availability: true,
        stationLinks: true,
      },
    });
    if (!row) throw new ItemNotFoundError();
    return this.toView(row);
  }

  async create(tenantId: string, sectionId: string, dto: CreateItemDto): Promise<MenuItemView> {
    await this.assertSection(tenantId, sectionId);
    if (dto.productId) await this.assertProduct(tenantId, dto.productId);
    if (dto.modifierGroupIds?.length) await this.assertModifierGroups(tenantId, dto.modifierGroupIds);
    if (dto.stationIds?.length) {
      const branch = await this.branchOfSection(sectionId);
      await this.assertStations(tenantId, branch, dto.stationIds);
    }

    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.menuItem.create({
        data: {
          tenantId,
          sectionId,
          name: dto.name,
          description: dto.description ?? null,
          basePrice: new Prisma.Decimal(dto.basePrice),
          productId: dto.productId ?? null,
          position: dto.position ?? 0,
          itemType: dto.itemType ?? null,
          prepMinutes: dto.prepMinutes ?? null,
          // Prisma persists an empty array explicitly — legacy rows keep their
          // existing default (empty). Never send `undefined`, that becomes NULL.
          dietaryTags: dto.dietaryTags ?? [],
          imageUrl: dto.imageUrl ?? null,
        },
      });
      if (dto.modifierGroupIds?.length) {
        await tx.menuItemModifierGroup.createMany({
          data: dto.modifierGroupIds.map((mgId, i) => ({
            menuItemId: created.id,
            modifierGroupId: mgId,
            position: i,
          })),
        });
      }
      if (dto.channelPrices?.length) {
        await tx.menuItemChannelPrice.createMany({
          data: dto.channelPrices.map((cp) => ({
            menuItemId: created.id,
            channel: cp.channel,
            price: new Prisma.Decimal(cp.price),
          })),
        });
      }
      if (dto.availability?.length) {
        await tx.menuAvailability.createMany({
          data: dto.availability.map((a) => ({
            menuItemId: created.id,
            dayOfWeek: a.dayOfWeek as 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN',
            startTime: a.startTime,
            endTime: a.endTime,
          })),
        });
      }
      if (dto.stationIds?.length) {
        await tx.menuItemStationLink.createMany({
          data: dto.stationIds.map((sid) => ({ menuItemId: created.id, stationId: sid })),
        });
      }
      return created.id;
    });

    return this.get(tenantId, item);
  }

  async update(tenantId: string, itemId: string, dto: UpdateItemDto): Promise<MenuItemView> {
    const existing = await this.prisma.menuItem.findFirst({
      where: { id: itemId, tenantId },
      select: { id: true, sectionId: true },
    });
    if (!existing) throw new ItemNotFoundError();

    if (dto.productId !== undefined && dto.productId !== '') {
      await this.assertProduct(tenantId, dto.productId);
    }
    if (dto.modifierGroupIds) await this.assertModifierGroups(tenantId, dto.modifierGroupIds);
    if (dto.stationIds) {
      const branch = await this.branchOfSection(existing.sectionId);
      await this.assertStations(tenantId, branch, dto.stationIds);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.menuItem.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          basePrice: dto.basePrice !== undefined ? new Prisma.Decimal(dto.basePrice) : undefined,
          productId:
            dto.productId !== undefined
              ? dto.productId === ''
                ? null
                : dto.productId
              : undefined,
          position: dto.position ?? undefined,
          isActive: dto.isActive ?? undefined,
          itemType: dto.itemType !== undefined ? dto.itemType : undefined,
          prepMinutes: dto.prepMinutes !== undefined ? dto.prepMinutes : undefined,
          dietaryTags: dto.dietaryTags !== undefined ? dto.dietaryTags : undefined,
          // Empty string clears the image; undefined leaves it untouched.
          imageUrl:
            dto.imageUrl !== undefined ? (dto.imageUrl === '' ? null : dto.imageUrl) : undefined,
        },
      });
      if (dto.modifierGroupIds) {
        await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId: existing.id } });
        if (dto.modifierGroupIds.length) {
          await tx.menuItemModifierGroup.createMany({
            data: dto.modifierGroupIds.map((mgId, i) => ({
              menuItemId: existing.id,
              modifierGroupId: mgId,
              position: i,
            })),
          });
        }
      }
      if (dto.channelPrices) {
        await tx.menuItemChannelPrice.deleteMany({ where: { menuItemId: existing.id } });
        if (dto.channelPrices.length) {
          await tx.menuItemChannelPrice.createMany({
            data: dto.channelPrices.map((cp) => ({
              menuItemId: existing.id,
              channel: cp.channel,
              price: new Prisma.Decimal(cp.price),
            })),
          });
        }
      }
      if (dto.availability) {
        await tx.menuAvailability.deleteMany({ where: { menuItemId: existing.id } });
        if (dto.availability.length) {
          await tx.menuAvailability.createMany({
            data: dto.availability.map((a) => ({
              menuItemId: existing.id,
              dayOfWeek: a.dayOfWeek as 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN',
              startTime: a.startTime,
              endTime: a.endTime,
            })),
          });
        }
      }
      if (dto.stationIds) {
        await tx.menuItemStationLink.deleteMany({ where: { menuItemId: existing.id } });
        if (dto.stationIds.length) {
          await tx.menuItemStationLink.createMany({
            data: dto.stationIds.map((sid) => ({ menuItemId: existing.id, stationId: sid })),
          });
        }
      }
    });

    return this.get(tenantId, itemId);
  }

  // ── Assertions ──────────────────────────────────────────────
  private async assertSection(tenantId: string, sectionId: string): Promise<void> {
    const s = await this.prisma.menuSection.findFirst({
      where: { id: sectionId, tenantId },
      select: { id: true },
    });
    if (!s) throw new SectionNotFoundError();
  }

  private async assertProduct(tenantId: string, productId: string): Promise<void> {
    const p = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!p) throw new ItemProductCrossTenantError();
  }

  private async assertModifierGroups(tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const found = await this.prisma.modifierGroup.count({
      where: { tenantId, id: { in: ids } },
    });
    if (found !== ids.length) throw new ModifierGroupNotFoundError();
  }

  private async branchOfSection(sectionId: string): Promise<string> {
    const row = await this.prisma.menuSection.findUniqueOrThrow({
      where: { id: sectionId },
      select: { menu: { select: { branchId: true } } },
    });
    return row.menu.branchId;
  }

  private async assertStations(tenantId: string, branchId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const found = await this.prisma.kitchenStation.count({
      where: { tenantId, branchId, id: { in: ids } },
    });
    if (found !== ids.length) throw new StationNotFoundError();
  }

  private toView(
    row: Prisma.MenuItemGetPayload<{
      include: {
        modifierGroups: true;
        channelPrices: true;
        availability: true;
        stationLinks: true;
      };
    }>,
  ): MenuItemView {
    return {
      id: row.id,
      sectionId: row.sectionId,
      name: row.name,
      description: row.description,
      basePrice: row.basePrice.toFixed(2),
      productId: row.productId,
      isActive: row.isActive,
      position: row.position,
      modifierGroupIds: row.modifierGroups.map((mg) => mg.modifierGroupId),
      stationIds: row.stationLinks.map((sl) => sl.stationId),
      channelPrices: row.channelPrices.map((cp) => ({
        channel: cp.channel,
        price: cp.price.toFixed(2),
      })),
      availability: row.availability.map((a) => ({
        dayOfWeek: a.dayOfWeek,
        startTime: a.startTime,
        endTime: a.endTime,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      itemType: row.itemType,
      prepMinutes: row.prepMinutes,
      dietaryTags: row.dietaryTags,
      imageUrl: row.imageUrl,
    };
  }
}
