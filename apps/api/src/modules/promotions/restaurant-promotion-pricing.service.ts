import { Injectable } from '@nestjs/common';
import { Prisma, QuantityType, RestaurantOrderChannel } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  eligiblePromotionRules,
  noPromotions,
  priceLines,
  type PricedDocument,
} from './promotion-pricing';
import { PromotionsRepository } from './promotions.repository';

/**
 * Promotions on a restaurant bill.
 *
 * D52 deferred this with a reason that has since expired: "there is no
 * promotion pricing engine anywhere". D123 built one
 * (`packages/shared/src/promotions/applier.ts`) and retail has charged
 * promotions through it since. What was left was wiring, which is this class —
 * a restaurant order's items in, the same applier's answer out.
 *
 * It is a service rather than a pure function only because it needs two reads
 * (the tenant's live promotions, and which products are sold by measure). The
 * decision itself stays in the pure layer, so the running bill, the close and
 * the takeaway settle all get the same answer from the same code.
 *
 * ## Why the channel is passed and never assumed
 *
 * `isPromotionActive` refuses a channel-scoped promotion when the context
 * names no channel, so a caller that omitted it would silently price nothing.
 * Dine-in passes DINE_IN, takeaway TAKEAWAY — the same values the till's own
 * catalogue read sends, so the badge on the menu card and the discount on the
 * bill are decided by one predicate over one set of inputs.
 */
@Injectable()
export class RestaurantPromotionPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionsRepository,
    // D139 — the tenant's zone. A promotion scheduled "Fridays 11:00–15:00"
    // means the operator's Friday, not the server's.
    private readonly settings: SettingsService,
  ) {}

  /**
   * Price one restaurant order's non-voided items.
   *
   * `client` lets a caller inside a transaction read through it, so the close
   * prices the same rows it is about to settle. Callers with no transaction
   * (the running-bill preview) pass nothing and read through the pool.
   */
  async priceOrderItems(
    tenantId: string,
    branchId: string,
    channel: RestaurantOrderChannel,
    items: readonly RestaurantPricingItem[],
    client: Prisma.TransactionClient | null = null,
  ): Promise<PricedDocument> {
    if (items.length === 0) return noPromotions(items);

    const db = client ?? this.prisma;
    // The SAME read the POS catalogue badges from, so the offer a guest is
    // shown on the menu card and the discount taken off their bill cannot
    // come from two different queries.
    const active = await this.promotions.listForCatalogue(tenantId, client);
    const rules = eligiblePromotionRules(active, {
      now: new Date(),
      branchId,
      channel,
      tenantTimeZone: this.settings.getSettings(tenantId).timezone,
    });
    if (rules.length === 0) return noPromotions(items);

    /*
     * D134a — a line sold by weight is invisible to the quantity-based kinds.
     * Read from the product rather than inferred from a fractional quantity: a
     * whole-unit dish ordered as 1.000 is not measured, and treating it as one
     * would quietly exclude every dine-in line from bundles and BOGOs.
     */
    const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is string => !!id))];
    const measured = new Set<string>();
    if (productIds.length > 0) {
      const products = await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, quantityType: true },
      });
      for (const p of products) {
        if (p.quantityType === QuantityType.DECIMAL) measured.add(p.id);
      }
    }

    return priceLines(
      items.map((item) => ({
        id: item.id,
        productId: item.productId,
        // Modifiers are part of what the guest pays for the line, so they are
        // part of what a percentage discounts — the same unit price the bill,
        // the preview and the receipt all show.
        unitPrice: item.unitPrice.plus(item.modifierTotal),
        quantity: item.quantity,
        lineSubtotal: item.unitPrice.plus(item.modifierTotal).mul(item.quantity),
        isMeasured: item.productId ? measured.has(item.productId) : false,
      })),
      rules,
    );
  }
}

/** The slice of a `RestaurantOrderItem` pricing reads. */
export interface RestaurantPricingItem {
  id: string;
  productId: string | null;
  unitPrice: Prisma.Decimal;
  modifierTotal: Prisma.Decimal;
  quantity: Prisma.Decimal;
}
