import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderChannel, Prisma, SellableKind } from '@hardware-pos/database';
import { coerceAttributeQueryValue, domainFor } from '@hardware-pos/shared';
import type { TenantCapabilities } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { stockStateFor, type StockState } from '../../common/stock-state';
import { variantDisplayName } from '../../common/variant-display';
import { isPromotionActive } from '../promotions/promotions.evaluator';
import { PromotionsRepository } from '../promotions/promotions.repository';
import { BusinessProfileService } from '../platform/business-profile.service';

/**
 * D62 — `GET /products/sellable`: the ONE POS read model (convergence plan
 * §9.3, Phase 5). Replaces `GET /restaurant/pos-catalogue`, which now
 * delegates here and reshapes to its legacy contract until its sunset.
 *
 * ## Capability-shaped, not domain-shaped
 *
 * Which blocks appear is decided by the tenant's capabilities, resolved
 * once server-side. A retail tenant gets NO `modifierGroups` key — not an
 * empty array, which would be indistinguishable from "has none configured"
 * (the plan's §9.5 nullability rule). A new domain gets a working POS grid
 * from this endpoint without a new endpoint.
 *
 * ## Money is a decimal STRING
 *
 * A JSON number cannot hold 0.1 + 0.2 and every client re-parses anyway.
 *
 * ## Price resolution happens HERE, once
 *
 * base → collection override → channel override, and the response says
 * which rule won (`priceSource`), so no client re-derives pricing.
 */

export interface SellableQuery {
  branchId: string;
  channel?: OrderChannel;
  collectionId?: string;
  categoryId?: string;
  sellableKind?: SellableKind;
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT';
  search?: string;
  cursor?: string;
  limit?: number;
  /** D64 — raw `attr[key]=value` filters; validated against the domain schema. */
  attr?: Record<string, string>;
}

export type PriceSource = 'BASE' | 'COLLECTION_OVERRIDE' | 'CHANNEL_OVERRIDE';
export type { StockState };

export interface SellableItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sellableKind: SellableKind;
  /** Null when variants own the price. Decimal string otherwise. */
  unitPrice: string | null;
  effectivePrice: string | null;
  priceSource: PriceSource;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  hasVariants: boolean;
  variants?: {
    id: string;
    sku: string;
    name: string;
    unitPrice: string;
    isDefault: boolean;
    isActive: boolean;
    /**
     * D99 — this variant's own branch stock, so the till can grey out a size and
     * cap its stepper. `null` when the tenant does not track stock; `"0.000"`
     * when the variant has no `BranchInventory` row, which is no stock rather
     * than unknown (decision 8).
     */
    availableQuantity: string | null;
    stockState: StockState;
  }[];
  // Present only when capabilities.catalogue.preparation.
  prepMinutes?: number | null;
  dietaryTags?: string[];
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null;
  // Present only when capabilities.catalogue.modifiers.
  modifierGroups?: {
    id: string;
    name: string;
    selection: 'SINGLE' | 'MULTIPLE';
    minSelections: number;
    maxSelections: number;
    role: string | null;
    options: { id: string; name: string; priceDelta: string; isActive: boolean }[];
  }[];
  // Present only when capabilities.fulfilment.stationRouting.
  stations?: { id: string; code: string; name: string; category: string }[];
  promotions: { id: string; name: string; type: string; description: string | null }[];
  // Present only when the tenant tracks stock.
  availableQuantity?: string | null;
  stockState?: StockState;
}

export interface SellableResponse {
  items: SellableItem[];
  total: number;
  nextCursor: string | null;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

/** Keyset cursor over (name, id) — the listing's stable order. */
function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}
function decodeCursor(cursor: string): { name: string; id: string } | null {
  try {
    const [name, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof name === 'string' && typeof id === 'string') return { name, id };
  } catch {
    /* fall through */
  }
  return null;
}

@Injectable()
export class SellableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionsRepository,
    private readonly profiles: BusinessProfileService,
  ) {}

  async list(tenantId: string, query: SellableQuery): Promise<SellableResponse> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    const caps: TenantCapabilities = profile.capabilities;
    const tracksStock = profile.inventoryMode !== 'DISABLED';
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const after = query.cursor ? decodeCursor(query.cursor) : null;

    /*
     * Composable AND-clauses instead of one object literal: the variants
     * rule, the search OR and the keyset OR would otherwise fight over the
     * single top-level `OR` key.
     */
    const and: Prisma.ProductWhereInput[] = [
      // A hasVariants product with no active variants must not surface —
      // every render path would offer options that error out when tapped.
      { OR: [{ hasVariants: false }, { hasVariants: true, variants: { some: { isActive: true } } }] },
    ];
    if (query.search) {
      and.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { dietaryTags: { has: query.search } },
          { subcategory: { name: { contains: query.search, mode: 'insensitive' } } },
        ],
      });
    }
    // D64 — attribute filters. Keys must exist in the tenant domain's schema
    // and values must coerce to the field's type: an unknown key or an
    // uncoercible value is a 400 naming itself, never a silently-empty page.
    if (query.attr && Object.keys(query.attr).length > 0) {
      const schema = domainFor(profile.businessType).catalogue.attributeSchema;
      const byKey = new Map(schema.map((f) => [f.key, f]));
      for (const [attrKey, raw] of Object.entries(query.attr)) {
        const field = byKey.get(attrKey);
        if (!field) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_FILTER_INVALID',
            message: `Unknown attribute filter "${attrKey}" for this business type.`,
          });
        }
        const coerced = coerceAttributeQueryValue(field, raw);
        if (!coerced.ok) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_FILTER_INVALID',
            message: coerced.message,
          });
        }
        and.push({ attributes: { path: [attrKey], equals: coerced.value } });
      }
    }
    // The keyset clause pages; the clauses above FILTER. `total` counts the
    // filter only, so it is stable across pages.
    const filterAnd = [...and];
    if (after) {
      and.push({
        OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }],
      });
    }
    const where: Prisma.ProductWhereInput = {
      tenantId,
      isActive: true,
      ...(query.sellableKind ? { sellableKind: query.sellableKind } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(caps.catalogue.preparation && query.foodType ? { foodType: query.foodType } : {}),
      ...(query.collectionId
        ? {
            catalogueEntries: {
              some: {
                isActive: true,
                section: {
                  menuId: query.collectionId,
                  // D66 — a channel-scoped assortment only serves its
                  // channels: asking a DINE_IN-only collection for TAKEAWAY
                  // yields an empty page, not the collection anyway.
                  ...(query.channel
                    ? {
                        menu: {
                          OR: [
                            { channels: { isEmpty: true } },
                            { channels: { has: query.channel } },
                          ],
                        },
                      }
                    : {}),
                },
              },
            },
          }
        : {}),
      AND: and,
    };

    // ONE query for the page (+1 row to learn whether there is a next page),
    // one count, one promotions read. Constant in the number of products.
    const [rows, total, activePromotions] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: {
          category: { select: { id: true, name: true } },
          subcategory: { select: { id: true, name: true } },
          variants: {
            where: { isActive: true },
            orderBy: [{ position: 'asc' }, { sku: 'asc' }],
            include: { optionValues: { include: { option: { select: { name: true } } } } },
          },
          modifierGroups: {
            orderBy: [{ position: 'asc' }],
            include: {
              modifierGroup: {
                include: { options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
              },
            },
          },
          stationLinks: {
            where: { station: { branchId: query.branchId } },
            include: { station: true },
          },
          promotionItems: { select: { promotionId: true } },
          ...(query.collectionId
            ? {
                catalogueEntries: {
                  where: { section: { menuId: query.collectionId }, isActive: true },
                  include: { channelPrices: true },
                },
              }
            : {}),
        },
      }),
      this.prisma.product.count({ where: { ...where, AND: filterAnd } }),
      this.promotions.listForCatalogue(tenantId),
    ]);

    // D99 — one read for every variant on the page, so the till can badge each
    // size. Keyed by variant; a variant with no row is simply absent, and reads
    // below as zero (decision 8: variant stock comes from goods receipts).
    const variantIds = rows.flatMap((p) => p.variants.map((v) => v.id));
    const variantStock = new Map<string, { qty: Prisma.Decimal; reorderLevel: Prisma.Decimal | null }>();
    if (variantIds.length > 0) {
      const cells = await this.prisma.branchInventory.findMany({
        where: {
          tenantId,
          branchId: query.branchId,
          productVariantId: { in: variantIds },
        },
        select: { productVariantId: true, quantityOnHand: true, reorderLevel: true },
      });
      for (const cell of cells) {
        if (cell.productVariantId === null) continue;
        variantStock.set(cell.productVariantId, {
          qty: cell.quantityOnHand,
          reorderLevel: cell.reorderLevel,
        });
      }
    }

    const now = new Date();
    const validPromotionsById = new Map<
      string,
      { id: string; name: string; type: string; description: string | null }
    >();
    for (const promo of activePromotions) {
      if (isPromotionActive(promo, { now, branchId: query.branchId, channel: query.channel })) {
        validPromotionsById.set(promo.id, {
          id: promo.id,
          name: promo.name,
          type: promo.type,
          description: promo.description,
        });
      }
    }

    const page = rows.slice(0, limit);
    const items: SellableItem[] = page.map((p) => {
      // ── price resolution, once, server-side ─────────────────────────────
      const base = p.hasVariants ? null : p.unitPrice;
      let effective = base;
      let priceSource: PriceSource = 'BASE';
      const entry =
        'catalogueEntries' in p
          ? (p as typeof p & { catalogueEntries: { priceOverride: Prisma.Decimal | null; channelPrices: { channel: string; price: Prisma.Decimal }[] }[] }).catalogueEntries[0]
          : undefined;
      if (entry) {
        const channelPrice = query.channel
          ? entry.channelPrices.find((cp) => cp.channel === query.channel)
          : undefined;
        if (channelPrice) {
          effective = channelPrice.price;
          priceSource = 'CHANNEL_OVERRIDE';
        } else if (entry.priceOverride) {
          effective = entry.priceOverride;
          priceSource = 'COLLECTION_OVERRIDE';
        }
      }

      const item: SellableItem = {
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        sellableKind: p.sellableKind,
        unitPrice: base ? base.toFixed(2) : null,
        effectivePrice: effective ? effective.toFixed(2) : null,
        priceSource,
        category: p.category ? { id: p.category.id, name: p.category.name } : null,
        subcategory: p.subcategory ? { id: p.subcategory.id, name: p.subcategory.name } : null,
        hasVariants: p.hasVariants,
        promotions: p.promotionItems
          .map((pi) => validPromotionsById.get(pi.promotionId))
          .filter((v): v is NonNullable<typeof v> => Boolean(v)),
      };

      if (caps.catalogue.variants) {
        item.variants = p.variants.map((v) => {
          // Same UNTRACKED reasoning as the item level: a tenant that tracks no
          // stock gets null rather than a fabricated zero.
          const cell = variantStock.get(v.id);
          const qty = cell?.qty ?? new Prisma.Decimal(0);
          return {
            id: v.id,
            sku: v.sku,
            name: variantDisplayName(v.optionValues, v.sku),
            unitPrice: v.unitPrice.toFixed(2),
            isDefault: v.isDefault,
            isActive: v.isActive,
            availableQuantity: tracksStock ? qty.toFixed(3) : null,
            stockState: tracksStock ? stockStateFor(qty, cell?.reorderLevel ?? null) : 'UNTRACKED',
          };
        });
      }
      if (caps.catalogue.preparation) {
        item.prepMinutes = p.prepMinutes;
        item.dietaryTags = p.dietaryTags;
        item.foodType = p.foodType as SellableItem['foodType'];
      }
      if (caps.catalogue.modifiers) {
        item.modifierGroups = p.modifierGroups.map((row) => ({
          id: row.modifierGroup.id,
          name: row.modifierGroup.name,
          selection: row.modifierGroup.selection,
          minSelections: row.modifierGroup.minSelections,
          maxSelections: row.modifierGroup.maxSelections,
          role: row.modifierGroup.role,
          options: row.modifierGroup.options.map((o) => ({
            id: o.id,
            name: o.name,
            priceDelta: o.priceDelta.toFixed(2),
            isActive: o.isActive,
          })),
        }));
      }
      if (caps.fulfilment.stationRouting) {
        item.stations = p.stationLinks.map((row) => ({
          id: row.station.id,
          code: row.station.code,
          name: row.station.name,
          category: row.station.category,
        }));
      }
      if (tracksStock) {
        // UNTRACKED is a real, distinct state — a SERVICE sells with no
        // stock claim and must not read as OUT. COMPOSED_ITEM joins it until
        // Phase 8 wires component depletion: restaurant orders have never
        // moved stock (plan D-5), so a dish's quantityOnHand is a number
        // nothing maintains — claiming OUT from it would grey out food the
        // kitchen is happily cooking.
        if (p.sellableKind === 'SERVICE' || p.sellableKind === 'COMPOSED_ITEM') {
          item.availableQuantity = null;
          item.stockState = 'UNTRACKED';
        } else {
          const qty = p.quantityOnHand;
          item.availableQuantity = qty.toFixed(3);
          item.stockState = stockStateFor(qty, p.reorderLevel);
        }
      }
      return item;
    });

    const last = page[page.length - 1];
    return {
      items,
      total,
      nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
    };
  }
}
