import { Injectable } from '@nestjs/common';
import {
  MOCK_HARDWARE_PRODUCTS,
  mockCategoryId,
  mockCategoryNames,
  Prisma,
  Product,
} from '@hardware-pos/database';

import { mirrorExternalRef } from '../quickbooks/external-ref';
import { PrismaService } from '../../prisma/prisma.service';

export interface ProductSearchFilters {
  name?: string;
  sku?: string;
  categoryId?: string;
  subcategoryId?: string;
  isActive?: boolean;
}

export interface ProductListFilters {
  search?: string;
  categoryId?: string;
  subcategoryId?: string;
  isActive?: boolean;
  type?: string;
  syncStatus?: Prisma.ProductWhereInput['syncStatus'];
  stockStatus?: 'IN' | 'OUT' | 'LOW';
}

export interface MockSyncSummary {
  created: number;
  updated: number;
  total: number;
  categories: number;
}

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Free-text search across name / sku (used by GET /products). */
  async search(
    tenantId: string,
    search: string | undefined,
    skip: number,
    take: number,
  ): Promise<[Product[], number]> {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.product.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
  }

  /**
   * Active-variant count and price span for a page of products.
   *
   * D44 says the parent-level `unitPrice` / `sku` are legacy fallbacks that are
   * "not read" once `hasVariants` is true — the variant rows own them. The admin
   * list and the product picker were reading them anyway and rendering Rs 0.00
   * against every variant product in the catalogue.
   *
   * A separate groupBy rather than an `include` on the list query: including the
   * variant rows would put a 12-row array on every product in the response just
   * to derive three numbers, and would change the shape the controller returns.
   *
   * Inactive variants are excluded — a discontinued colour must not widen the
   * price range an operator sees.
   */
  async variantPriceSummary(
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, { count: number; min: number | null; max: number | null }>> {
    const out = new Map<string, { count: number; min: number | null; max: number | null }>();
    if (productIds.length === 0) return out;

    const rows = await this.prisma.productVariant.groupBy({
      by: ['productId'],
      where: { tenantId, productId: { in: productIds }, isActive: true },
      _count: { _all: true },
      _min: { unitPrice: true },
      _max: { unitPrice: true },
    });

    for (const r of rows) {
      out.set(r.productId, {
        count: r._count._all,
        min: r._min.unitPrice == null ? null : Number(r._min.unitPrice),
        max: r._max.unitPrice == null ? null : Number(r._max.unitPrice),
      });
    }
    return out;
  }

  /** Structured search combining name / sku / category / active status. */
  async advancedSearch(
    tenantId: string,
    filters: ProductSearchFilters,
    skip: number,
    take: number,
  ): Promise<[Product[], number]> {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(filters.name ? { name: { contains: filters.name, mode: 'insensitive' } } : {}),
      ...(filters.sku ? { sku: { contains: filters.sku, mode: 'insensitive' } } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.subcategoryId ? { subcategoryId: filters.subcategoryId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.product.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
  }

  /** Look up a subcategory (id + parent) to validate product ↔ category alignment. */
  findSubcategory(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; categoryId: string } | null> {
    return this.prisma.productSubcategory.findFirst({
      where: { id, tenantId },
      select: { id: true, categoryId: true },
    });
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Product | null> {
    return this.prisma.product.findFirst({ where: { id, tenantId } });
  }

  /** Management list: search + category / active / sync / stock filters. */
  async listManaged(
    tenantId: string,
    filters: ProductListFilters,
    skip: number,
    take: number,
  ): Promise<[Product[], number]> {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { sku: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.subcategoryId ? { subcategoryId: filters.subcategoryId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.syncStatus ? { syncStatus: filters.syncStatus } : {}),
      // Stock filters only make sense for stock-tracked (Inventory) items.
      ...(filters.stockStatus === 'OUT'
        ? { type: 'Inventory', quantityOnHand: { lte: 0 } }
        : filters.stockStatus === 'IN'
          ? { type: 'Inventory', quantityOnHand: { gt: 0 } }
          : filters.stockStatus === 'LOW'
            ? {
                type: 'Inventory',
                reorderLevel: { not: null },
                quantityOnHand: { gt: 0, lte: this.prisma.product.fields.reorderLevel },
              }
            : {}),
    };

    return this.prisma.$transaction([
      this.prisma.product.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
  }

  create(tenantId: string, data: Prisma.ProductUncheckedCreateInput): Promise<Product> {
    return this.prisma.product.create({ data: { ...data, tenantId } });
  }

  update(id: string, data: Prisma.ProductUncheckedUpdateInput): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data });
  }

  /**
   * Simulate a QuickBooks catalog pull: upsert the mock hardware products and
   * their categories, marking each SYNCED. This is the ONLY write path for the
   * product cache — the POS never edits stock directly. Runs in a transaction
   * and records a single inbound SyncLog entry.
   */
  async mockSync(tenantId: string): Promise<MockSyncSummary> {
    return this.prisma.$transaction(async (tx) => {
      // Ensure categories (deterministic ids keep repeated syncs idempotent).
      for (const name of mockCategoryNames()) {
        const id = mockCategoryId(tenantId, name);
        await tx.productCategory.upsert({
          where: { id },
          update: { name, isActive: true },
          create: { id, tenantId, name },
        });
      }

      let created = 0;
      let updated = 0;
      const now = new Date();

      for (const p of MOCK_HARDWARE_PRODUCTS) {
        const existing = await tx.product.findUnique({
          where: { tenantId_quickbooksItemId: { tenantId, quickbooksItemId: p.quickbooksItemId } },
        });

        const data = {
          name: p.name,
          sku: p.sku,
          description: p.description ?? null,
          categoryId: mockCategoryId(tenantId, p.category),
          unitPrice: p.unitPrice,
          quantityOnHand: p.quantityOnHand,
          quantityAsOfDate: now,
          type: p.type,
          isActive: true,
          syncStatus: 'SYNCED' as const,
          lastSyncedAt: now,
        };

        const upserted = await tx.product.upsert({
          where: { tenantId_quickbooksItemId: { tenantId, quickbooksItemId: p.quickbooksItemId } },
          update: data,
          create: { tenantId, quickbooksItemId: p.quickbooksItemId, ...data },
        });
        // D63 dual-write.
        await mirrorExternalRef(tx, tenantId, 'PRODUCT', upserted.id, {
          externalId: p.quickbooksItemId,
          syncStatus: 'SYNCED',
          lastSyncedAt: now,
        });

        if (existing) updated++;
        else created++;
      }

      await tx.syncLog.create({
        data: {
          tenantId,
          entityType: 'PRODUCT',
          direction: 'INBOUND',
          status: 'SYNCED',
          message: `Mock QuickBooks product sync: ${created} created, ${updated} updated`,
        },
      });

      return { created, updated, total: MOCK_HARDWARE_PRODUCTS.length, categories: mockCategoryNames().length };
    });
  }
}
