import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { isPromotionActive } from '../promotions/promotions.evaluator';
import { PromotionsRepository } from '../promotions/promotions.repository';

/**
 * D45 — Restaurant POS Catalogue read model.
 *
 * A single `GET` returns the tenant's currently-sellable Products for one
 * branch, ready to render into the counter POS grid. Every dependent shape
 * (variants, modifier groups, kitchen stations, active promotions) is fetched
 * in ONE Prisma `include` call so the endpoint never fires an N+1 loop across
 * hundreds of catalogue rows.
 *
 * Promotion badging is filtered per-product through the pure evaluator, so a
 * promotion that is scheduled but not yet valid (weekend-only, or 5-10pm)
 * does not appear at 3pm.
 */
export interface PosCatalogueQuery {
  branchId: string;
  channel?: string;
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT';
  search?: string;
}

export interface PosCatalogueItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  unitPrice: number | null;
  prepMinutes: number | null;
  dietaryTags: string[];
  foodType: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  hasVariants: boolean;
  variants: {
    id: string;
    sku: string;
    name: string;
    unitPrice: number;
    isDefault: boolean;
    isActive: boolean;
  }[];
  modifierGroups: {
    id: string;
    name: string;
    selection: 'SINGLE' | 'MULTIPLE';
    minSelections: number;
    maxSelections: number;
    role: string | null;
    options: { id: string; name: string; priceDelta: number; isActive: boolean }[];
  }[];
  stations: { id: string; code: string; name: string; category: string }[];
  promotions: { id: string; name: string; type: string; description: string | null }[];
}

export interface PosCatalogueResponse {
  items: PosCatalogueItem[];
  total: number;
}

@Injectable()
export class PosCatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionsRepository,
  ) {}

  async list(tenantId: string, query: PosCatalogueQuery): Promise<PosCatalogueResponse> {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      isActive: true,
      ...(query.foodType ? { foodType: query.foodType } : {}),
      // At least one active variant OR a non-variant product. A hasVariants
      // product with no active variants must not surface — every render path
      // would offer options that error out when tapped.
      OR: [
        { hasVariants: false },
        { hasVariants: true, variants: { some: { isActive: true } } },
      ],
      ...(query.search
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { dietaryTags: { has: query.search } },
                  { subcategory: { name: { contains: query.search, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
      // TODO(D45-followup): per-product availability window (MenuAvailability
      // is on MenuItem today; Product-side availability is a follow-up).
    };

    // ONE query for the whole catalogue, plus ONE for the tenant's active
    // promotions. Prisma's include folds every relation into that single
    // round-trip, keeping the read strictly O(rows).
    const [products, activePromotions] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        include: {
          category: { select: { id: true, name: true } },
          subcategory: { select: { id: true, name: true } },
          variants: {
            where: { isActive: true },
            orderBy: [{ position: 'asc' }, { sku: 'asc' }],
            include: {
              optionValues: {
                include: { option: { select: { name: true } } },
              },
            },
          },
          modifierGroups: {
            orderBy: [{ position: 'asc' }],
            include: {
              modifierGroup: {
                include: {
                  options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
                },
              },
            },
          },
          stationLinks: {
            where: { station: { branchId: query.branchId } },
            include: { station: true },
          },
          promotionItems: {
            select: { promotionId: true },
          },
        },
      }),
      this.promotions.listForCatalogue(tenantId),
    ]);

    // Filter the promotion pool once per request, then map by id for O(1)
    // lookup per product row.
    const now = new Date();
    const validPromotionsById = new Map<
      string,
      { id: string; name: string; type: string; description: string | null }
    >();
    for (const promo of activePromotions) {
      if (
        isPromotionActive(promo, {
          now,
          branchId: query.branchId,
          channel: query.channel,
        })
      ) {
        validPromotionsById.set(promo.id, {
          id: promo.id,
          name: promo.name,
          type: promo.type,
          description: promo.description,
        });
      }
    }

    const items: PosCatalogueItem[] = products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      unitPrice: p.hasVariants ? null : p.unitPrice ? Number(p.unitPrice) : null,
      prepMinutes: p.prepMinutes,
      dietaryTags: p.dietaryTags,
      foodType: p.foodType as 'FOOD' | 'BEVERAGE' | 'DESSERT' | null,
      category: p.category ? { id: p.category.id, name: p.category.name } : null,
      subcategory: p.subcategory ? { id: p.subcategory.id, name: p.subcategory.name } : null,
      hasVariants: p.hasVariants,
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        // The variant "name" is the option-value combo (Small/Red, etc.) —
        // POS renders it as the chip label. Fallback to SKU if the variant
        // was created without variation options (a wizard shortcut path).
        name:
          v.optionValues.length > 0
            ? v.optionValues.map((ov) => ov.option?.name ?? '').join(' / ')
            : v.sku,
        unitPrice: Number(v.unitPrice),
        isDefault: v.isDefault,
        isActive: v.isActive,
      })),
      modifierGroups: p.modifierGroups.map((row) => ({
        id: row.modifierGroup.id,
        name: row.modifierGroup.name,
        selection: row.modifierGroup.selection,
        minSelections: row.modifierGroup.minSelections,
        maxSelections: row.modifierGroup.maxSelections,
        role: row.modifierGroup.role,
        options: row.modifierGroup.options.map((o) => ({
          id: o.id,
          name: o.name,
          priceDelta: Number(o.priceDelta),
          isActive: o.isActive,
        })),
      })),
      stations: p.stationLinks.map((row) => ({
        id: row.station.id,
        code: row.station.code,
        name: row.station.name,
        category: row.station.category,
      })),
      promotions: p.promotionItems
        .map((pi) => validPromotionsById.get(pi.promotionId))
        .filter((v): v is NonNullable<typeof v> => Boolean(v)),
    }));

    return { items, total: items.length };
  }
}
