import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * D62 — collections: the successor authoring surface for placements
 * (convergence plan §9.2; the tables are D60's).
 *
 * A collection is the generalised menu — `Menu`/`MenuSection` rows under
 * their real job description, holding `CatalogueEntry` placements of
 * PRODUCTS. The legacy `/restaurant/menus…` write routes 410 and point here;
 * these routes are why that pointer is honest.
 */

export interface CollectionView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
}

export interface CollectionSectionView {
  id: string;
  collectionId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
}

export interface CatalogueEntryView {
  id: string;
  sectionId: string;
  productId: string;
  productName: string;
  productVariantId: string | null;
  /** Decimal string, or null when the product's price applies. */
  priceOverride: string | null;
  /** The price that applies right now: override ?? product price. */
  effectivePrice: string;
  position: number;
  isActive: boolean;
}

@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  // ── collections ──────────────────────────────────────────────────────────

  async listCollections(tenantId: string, branchId: string): Promise<CollectionView[]> {
    const rows = await this.prisma.menu.findMany({
      where: { tenantId, branchId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toCollection(r));
  }

  async createCollection(
    tenantId: string,
    branchId: string,
    input: { name: string; description?: string },
  ): Promise<CollectionView> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const existing = await this.prisma.menu.findFirst({
      where: { branchId, name: input.name },
      select: { id: true },
    });
    if (existing) throw new BadRequestException(`A collection named "${input.name}" already exists`);
    const row = await this.prisma.menu.create({
      data: { tenantId, branchId, name: input.name, description: input.description ?? null },
    });
    return this.toCollection(row);
  }

  async updateCollection(
    tenantId: string,
    collectionId: string,
    input: { name?: string; description?: string | null; isActive?: boolean },
  ): Promise<CollectionView> {
    await this.requireCollection(tenantId, collectionId);
    const row = await this.prisma.menu.update({
      where: { id: collectionId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        version: { increment: 1 },
      },
    });
    return this.toCollection(row);
  }

  // ── sections ─────────────────────────────────────────────────────────────

  async listSections(tenantId: string, collectionId: string): Promise<CollectionSectionView[]> {
    await this.requireCollection(tenantId, collectionId);
    const rows = await this.prisma.menuSection.findMany({
      where: { menuId: collectionId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toSection(r));
  }

  async createSection(
    tenantId: string,
    collectionId: string,
    input: { name: string; description?: string; position?: number },
  ): Promise<CollectionSectionView> {
    await this.requireCollection(tenantId, collectionId);
    const dupe = await this.prisma.menuSection.findFirst({
      where: { menuId: collectionId, name: input.name },
      select: { id: true },
    });
    if (dupe) throw new BadRequestException(`A section named "${input.name}" already exists`);
    const row = await this.prisma.menuSection.create({
      data: {
        tenantId,
        menuId: collectionId,
        name: input.name,
        description: input.description ?? null,
        position: input.position ?? 0,
      },
    });
    return this.toSection(row);
  }

  async updateSection(
    tenantId: string,
    sectionId: string,
    input: { name?: string; description?: string | null; position?: number; isActive?: boolean },
  ): Promise<CollectionSectionView> {
    await this.requireSection(tenantId, sectionId);
    const row = await this.prisma.menuSection.update({
      where: { id: sectionId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return this.toSection(row);
  }

  // ── entries ──────────────────────────────────────────────────────────────

  async listEntries(tenantId: string, sectionId: string): Promise<CatalogueEntryView[]> {
    await this.requireSection(tenantId, sectionId);
    const rows = await this.prisma.catalogueEntry.findMany({
      where: { sectionId },
      orderBy: [{ position: 'asc' }],
      include: { product: { select: { name: true, unitPrice: true } } },
    });
    return rows.map((r) => this.toEntry(r));
  }

  async createEntry(
    tenantId: string,
    sectionId: string,
    input: {
      productId: string;
      productVariantId?: string;
      priceOverride?: string | number;
      position?: number;
    },
  ): Promise<CatalogueEntryView> {
    await this.requireSection(tenantId, sectionId);
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, tenantId },
      select: { id: true },
    });
    // Cross-tenant references 404 rather than being silently accepted.
    if (!product) throw new NotFoundException('Product not found');
    if (input.productVariantId) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: input.productVariantId, tenantId, productId: input.productId },
        select: { id: true },
      });
      if (!variant) throw new NotFoundException('Variant not found on this product');
    }
    const dupe = await this.prisma.catalogueEntry.findFirst({
      where: {
        sectionId,
        productId: input.productId,
        productVariantId: input.productVariantId ?? null,
      },
      select: { id: true },
    });
    if (dupe) throw new BadRequestException('This product is already placed in the section');
    const row = await this.prisma.catalogueEntry.create({
      data: {
        tenantId,
        sectionId,
        productId: input.productId,
        productVariantId: input.productVariantId ?? null,
        priceOverride:
          input.priceOverride !== undefined ? new Prisma.Decimal(input.priceOverride) : null,
        position: input.position ?? 0,
      },
      include: { product: { select: { name: true, unitPrice: true } } },
    });
    return this.toEntry(row);
  }

  async updateEntry(
    tenantId: string,
    entryId: string,
    input: { priceOverride?: string | number | null; position?: number; isActive?: boolean },
  ): Promise<CatalogueEntryView> {
    const existing = await this.prisma.catalogueEntry.findFirst({
      where: { id: entryId, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Entry not found');
    const row = await this.prisma.catalogueEntry.update({
      where: { id: entryId },
      data: {
        ...(input.priceOverride !== undefined
          ? {
              priceOverride:
                input.priceOverride === null ? null : new Prisma.Decimal(input.priceOverride),
            }
          : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      include: { product: { select: { name: true, unitPrice: true } } },
    });
    return this.toEntry(row);
  }

  /** D42/D43 heritage: archive, never hard-delete — history may reference it. */
  async archiveEntry(tenantId: string, entryId: string): Promise<CatalogueEntryView> {
    return this.updateEntry(tenantId, entryId, { isActive: false });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async requireCollection(tenantId: string, collectionId: string) {
    const row = await this.prisma.menu.findFirst({
      where: { id: collectionId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Collection not found');
  }

  private async requireSection(tenantId: string, sectionId: string) {
    const row = await this.prisma.menuSection.findFirst({
      where: { id: sectionId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Section not found');
  }

  private toCollection(r: {
    id: string;
    branchId: string;
    name: string;
    description: string | null;
    isActive: boolean;
    version: number;
  }): CollectionView {
    return {
      id: r.id,
      branchId: r.branchId,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      version: r.version,
    };
  }

  private toSection(r: {
    id: string;
    menuId: string;
    name: string;
    description: string | null;
    position: number;
    isActive: boolean;
  }): CollectionSectionView {
    return {
      id: r.id,
      collectionId: r.menuId,
      name: r.name,
      description: r.description,
      position: r.position,
      isActive: r.isActive,
    };
  }

  private toEntry(r: {
    id: string;
    sectionId: string;
    productId: string;
    productVariantId: string | null;
    priceOverride: Prisma.Decimal | null;
    position: number;
    isActive: boolean;
    product: { name: string; unitPrice: Prisma.Decimal };
  }): CatalogueEntryView {
    return {
      id: r.id,
      sectionId: r.sectionId,
      productId: r.productId,
      productName: r.product.name,
      productVariantId: r.productVariantId,
      priceOverride: r.priceOverride ? r.priceOverride.toFixed(2) : null,
      effectivePrice: (r.priceOverride ?? r.product.unitPrice).toFixed(2),
      position: r.position,
      isActive: r.isActive,
    };
  }
}
