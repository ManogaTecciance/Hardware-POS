import { Injectable } from '@nestjs/common';
import { Prisma, ProductVariant } from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Data access for `ProductVariant` and its variation dimensions/options.
 *
 * The repository owns the shape of the reads (which columns, which relations)
 * and every write, so the service reasons purely in domain terms and never
 * builds a `Prisma.*Args` object itself.
 */
@Injectable()
export class ProductVariantsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Product row scoped to tenant, or `null` if missing. */
  findProductForTenant(
    tenantId: string,
    productId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    hasVariants: boolean;
  } | null> {
    return this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, tenantId: true, hasVariants: true },
    });
  }

  /** Fetch dimensions + options for the variations tab. */
  listDimensions(productId: string) {
    return this.prisma.productVariationDimension.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        options: {
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
        },
      },
    });
  }

  /** Fetch every variant on a product with its option snapshot. */
  listVariants(productId: string) {
    return this.prisma.productVariant.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }, { sku: 'asc' }],
      include: {
        optionValues: {
          include: {
            dimension: { select: { id: true, name: true } },
            option: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  /** A single variant scoped to (tenant, product). */
  findVariant(tenantId: string, productId: string, variantId: string) {
    return this.prisma.productVariant.findFirst({
      where: { id: variantId, productId, tenantId },
      include: {
        optionValues: {
          include: {
            dimension: { select: { id: true, name: true } },
            option: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  /**
   * BranchInventory rows for a variant, joined with the branch name so the
   * per-branch stock table can render without a second call. Includes the
   * branch even when the variant has never been received into it (empty rows
   * are the responsibility of the service to synthesise if it wants to).
   */
  async listVariantInventory(tenantId: string, variantId: string) {
    return this.prisma.branchInventory.findMany({
      where: { tenantId, productVariantId: variantId },
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { branch: { name: 'asc' } },
    });
  }

  /**
   * Purchase-receipt lines for a variant, newest first, with header + supplier.
   * The service flattens these into the response shape D44 documents.
   */
  listVariantPurchases(tenantId: string, variantId: string) {
    return this.prisma.inventoryReceiptLine.findMany({
      where: { tenantId, productVariantId: variantId },
      orderBy: { receipt: { receivedAt: 'desc' } },
      include: {
        receipt: {
          include: { supplier: { select: { id: true, name: true } } },
        },
      },
    });
  }

  /**
   * Whether any downstream row references this variant. Used to refuse a
   * delete that would break audit history (D30 — no vacuous "delete succeeded"
   * on data that stopped existing).
   */
  async variantHasHistory(variantId: string): Promise<boolean> {
    const [sale, ret, menu, movement, receiptLine] = await Promise.all([
      this.prisma.saleItem.count({ where: { productVariantId: variantId } }),
      this.prisma.returnItem.count({ where: { productVariantId: variantId } }),
      this.prisma.menuItem.count({ where: { productVariantId: variantId } }),
      this.prisma.stockMovement.count({ where: { productVariantId: variantId } }),
      this.prisma.inventoryReceiptLine.count({ where: { productVariantId: variantId } }),
    ]);
    return sale + ret + menu + movement + receiptLine > 0;
  }

  updateVariant(
    variantId: string,
    data: Prisma.ProductVariantUncheckedUpdateInput,
  ): Promise<ProductVariant> {
    return this.prisma.productVariant.update({ where: { id: variantId }, data });
  }

  /** Hard delete: the caller must have proven no history references the row. */
  deleteVariant(variantId: string) {
    return this.prisma.productVariant.delete({ where: { id: variantId } });
  }
}
