import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateMenuDto,
  CreateSectionDto,
  UpdateMenuDto,
  UpdateSectionDto,
} from './dto/menu.dto';
import {
  BranchNotFoundError,
  MenuNameTakenError,
  MenuNotFoundError,
  MenuVersionConflictError,
  SectionNameTakenError,
  SectionNotFoundError,
} from './menu.errors';

export interface MenuView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SectionView {
  id: string;
  menuId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
}

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  async listMenus(tenantId: string, branchId: string, includeArchived = false): Promise<MenuView[]> {
    await this.assertBranch(tenantId, branchId);
    const rows = await this.prisma.menu.findMany({
      where: { tenantId, branchId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(this.menuToView);
  }

  async createMenu(
    tenantId: string,
    branchId: string,
    dto: CreateMenuDto,
  ): Promise<MenuView> {
    await this.assertBranch(tenantId, branchId);
    try {
      const created = await this.prisma.menu.create({
        data: { tenantId, branchId, name: dto.name, description: dto.description ?? null },
      });
      return this.menuToView(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new MenuNameTakenError(dto.name);
      }
      throw e;
    }
  }

  async updateMenu(
    tenantId: string,
    branchId: string,
    menuId: string,
    dto: UpdateMenuDto,
  ): Promise<MenuView> {
    const existing = await this.prisma.menu.findFirst({
      where: { id: menuId, tenantId, branchId },
    });
    if (!existing) throw new MenuNotFoundError();
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== existing.version) {
      throw new MenuVersionConflictError();
    }
    try {
      const updated = await this.prisma.menu.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          isActive: dto.isActive ?? undefined,
          version: { increment: 1 },
        },
      });
      return this.menuToView(updated);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new MenuNameTakenError(dto.name ?? existing.name);
      }
      throw e;
    }
  }

  // ── Sections ────────────────────────────────────────────────
  async listSections(tenantId: string, menuId: string): Promise<SectionView[]> {
    await this.assertMenu(tenantId, menuId);
    const rows = await this.prisma.menuSection.findMany({
      where: { tenantId, menuId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(this.sectionToView);
  }

  async createSection(
    tenantId: string,
    menuId: string,
    dto: CreateSectionDto,
  ): Promise<SectionView> {
    await this.assertMenu(tenantId, menuId);
    try {
      const created = await this.prisma.menuSection.create({
        data: {
          tenantId,
          menuId,
          name: dto.name,
          description: dto.description ?? null,
          position: dto.position ?? 0,
        },
      });
      return this.sectionToView(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new SectionNameTakenError(dto.name);
      }
      throw e;
    }
  }

  async updateSection(
    tenantId: string,
    menuId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ): Promise<SectionView> {
    const existing = await this.prisma.menuSection.findFirst({
      where: { id: sectionId, tenantId, menuId },
    });
    if (!existing) throw new SectionNotFoundError();
    try {
      const updated = await this.prisma.menuSection.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          position: dto.position ?? undefined,
          isActive: dto.isActive ?? undefined,
        },
      });
      return this.sectionToView(updated);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new SectionNameTakenError(dto.name ?? existing.name);
      }
      throw e;
    }
  }

  // ── Assertions ──────────────────────────────────────────────
  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new BranchNotFoundError();
  }

  private async assertMenu(tenantId: string, menuId: string): Promise<void> {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, tenantId },
      select: { id: true },
    });
    if (!menu) throw new MenuNotFoundError();
  }

  // ── Converters ──────────────────────────────────────────────
  private menuToView(row: Prisma.MenuGetPayload<Record<string, never>>): MenuView {
    return {
      id: row.id,
      branchId: row.branchId,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private sectionToView(row: Prisma.MenuSectionGetPayload<Record<string, never>>): SectionView {
    return {
      id: row.id,
      menuId: row.menuId,
      name: row.name,
      description: row.description,
      position: row.position,
      isActive: row.isActive,
    };
  }
}
