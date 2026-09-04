import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * D45 — Data access for `Promotion` + `PromotionItem`.
 *
 * The service builds domain objects; the repository builds `Prisma.*Args` and
 * runs the query. Keeping the split lets the service test with a fake `prisma`
 * that stubs the field-shaped delegates it consumes here.
 */
export interface PromotionWithItems {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  type: string;
  fixedPrice: Prisma.Decimal | null;
  percentageOff: Prisma.Decimal | null;
  amountOff: Prisma.Decimal | null;
  /** D105 — the cart threshold for a cart-level FIXED_AMOUNT_DISCOUNT. */
  minimumSpend: Prisma.Decimal | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  startsOn: Date | null;
  endsOn: Date | null;
  daysOfWeek: string[];
  startTime: string | null;
  endTime: string | null;
  branchScope: string[];
  channelScope: string[];
  stackable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  items: {
    id: string;
    productId: string;
    /**
     * D45 (4.10) — the product's CURRENT name, joined not snapshotted.
     *
     * This is an admin screen, not a receipt: an editor must show what the
     * product is called today. Without it `fromPromotion` had no name to give
     * the row, and the editor rendered the raw cuid — so creating a promotion
     * showed "Shirt" and editing the same one showed
     * "cmtldj0ta0003q4bs27ibki2q".
     */
    product: { name: string } | null;
    role: string;
    quantity: number;
  }[];
}

@Injectable()
export class PromotionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(tenantId: string, id: string): Promise<PromotionWithItems | null> {
    return this.prisma.promotion.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            productId: true,
            role: true,
            quantity: true,
            product: { select: { name: true } },
          },
        },
      },
    }) as Promise<PromotionWithItems | null>;
  }

  /**
   * Tenant-scoped list. Prisma-level filters cover the coarse cuts
   * (tenantId, isActive, productId membership); date-of-week / time-of-day
   * cannot be expressed as a `where` clause so the evaluator does that
   * filter post-fetch.
   */
  list(
    tenantId: string,
    opts: {
      isActive?: boolean;
      productId?: string;
      branchId?: string;
      channel?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<PromotionWithItems[]> {
    const where: Prisma.PromotionWhereInput = {
      tenantId,
      ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
      ...(opts.productId ? { items: { some: { productId: opts.productId } } } : {}),
      // Empty branchScope / channelScope means "all". We include either those
      // rows OR rows whose scope explicitly contains the caller's context.
      ...(opts.branchId
        ? { OR: [{ branchScope: { isEmpty: true } }, { branchScope: { has: opts.branchId } }] }
        : {}),
      ...(opts.channel
        ? { OR: [{ channelScope: { isEmpty: true } }, { channelScope: { has: opts.channel } }] }
        : {}),
    };
    return this.prisma.promotion.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        items: {
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            productId: true,
            role: true,
            quantity: true,
            product: { select: { name: true } },
          },
        },
      },
      take: opts.limit ?? 100,
      skip: opts.offset ?? 0,
    }) as Promise<PromotionWithItems[]>;
  }

  /**
   * List currently-active promotions for a tenant used by the POS Catalogue.
   * Kept as a distinct entry point (rather than a boolean on `list`) so the
   * hot POS-read query and the CRUD-list query can diverge without stepping
   * on each other's projections.
   */
  listForCatalogue(tenantId: string): Promise<PromotionWithItems[]> {
    return this.prisma.promotion.findMany({
      where: { tenantId, isActive: true },
      include: {
        items: {
          select: {
            id: true,
            productId: true,
            role: true,
            quantity: true,
            product: { select: { name: true } },
          },
        },
      },
    }) as Promise<PromotionWithItems[]>;
  }
}
