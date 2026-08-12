import { Injectable } from '@nestjs/common';
import { InventoryReceipt, InventoryReceiptLine, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { QueryReceiptsDto } from './dto/query-receipts.dto';

/**
 * Data access for `InventoryReceipt` and `InventoryReceiptLine`.
 *
 * Receipts are IMMUTABLE once written (D44) — this repository intentionally
 * exposes no `update` method for either shape. Idempotency is a read + create
 * pattern rather than an upsert, so the service can look up an existing row
 * without racing another writer.
 */
@Injectable()
export class InventoryReceiptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<InventoryReceipt | null> {
    return this.prisma.inventoryReceipt.findFirst({
      where: { tenantId, idempotencyKey },
    });
  }

  findWithLines(tenantId: string, id: string) {
    return this.prisma.inventoryReceipt.findFirst({
      where: { id, tenantId },
      include: {
        lines: true,
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  async list(tenantId: string, query: QueryReceiptsDto) {
    const where: Prisma.InventoryReceiptWhereInput = {
      tenantId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.from || query.to
        ? {
            receivedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.productId || query.productVariantId
        ? {
            lines: {
              some: {
                ...(query.productId ? { productId: query.productId } : {}),
                ...(query.productVariantId
                  ? { productVariantId: query.productVariantId }
                  : {}),
              },
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryReceipt.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          supplier: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
          _count: { select: { lines: true } },
        },
      }),
      this.prisma.inventoryReceipt.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Assert every product id belongs to the tenant, and — where a variant id
   * is given — that it belongs to the specific product. Returns a lookup of
   * `(productId → { name })` the service uses for user-facing error strings.
   */
  async assertProductsAndVariants(
    tenantId: string,
    lines: { productId: string; productVariantId?: string | null }[],
  ): Promise<Map<string, { name: string; type: string }>> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, name: true, type: true },
    });
    const productMap = new Map(products.map((p) => [p.id, { name: p.name, type: p.type }]));

    for (const line of lines) {
      if (!productMap.has(line.productId)) {
        return productMap; // caller decides how to fail; keep the shape simple
      }
    }

    const variantIds = lines
      .map((l) => l.productVariantId)
      .filter((id): id is string => !!id);
    if (variantIds.length > 0) {
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: variantIds }, tenantId },
        select: { id: true, productId: true },
      });
      const variantById = new Map(variants.map((v) => [v.id, v.productId]));
      for (const line of lines) {
        if (!line.productVariantId) continue;
        const owner = variantById.get(line.productVariantId);
        // A missing variant OR a variant belonging to a different product both
        // fail — the caller does not care which; the point is that this pair
        // is not a valid identity.
        if (owner === undefined || owner !== line.productId) {
          throw new Error(
            `Variant ${line.productVariantId} does not belong to product ${line.productId}`,
          );
        }
      }
    }
    return productMap;
  }

  /** Row-level readers for the tenant-wide average roll-up (D44). */
  async listBranchInventoryForProduct(tenantId: string, productId: string) {
    return this.prisma.branchInventory.findMany({
      where: { tenantId, productId, productVariantId: null },
      select: { quantityOnHand: true, averageCost: true },
    });
  }

  async listBranchInventoryForVariant(tenantId: string, productVariantId: string) {
    return this.prisma.branchInventory.findMany({
      where: { tenantId, productVariantId },
      select: { quantityOnHand: true, averageCost: true },
    });
  }
}

export type ReceiptWithLines = InventoryReceipt & { lines: InventoryReceiptLine[] };
