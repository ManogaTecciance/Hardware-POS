import { Injectable } from '@nestjs/common';
import { OrderChannel } from '@hardware-pos/database';

import { SellableService } from '../products/sellable.service';

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
  constructor(private readonly sellable: SellableService) {}

  /**
   * D62: a thin adapter over `SellableService` — the ONE query
   * implementation — reshaping to this route's legacy contract (money as
   * JS numbers, every key always present). Deleted with the alias at its
   * sunset; nothing else may grow here.
   */
  async list(tenantId: string, query: PosCatalogueQuery): Promise<PosCatalogueResponse> {
    const res = await this.sellable.list(tenantId, {
      branchId: query.branchId,
      channel: query.channel as OrderChannel | undefined,
      foodType: query.foodType,
      search: query.search,
      // The legacy contract had no pagination; serve the whole catalogue.
      limit: 200,
    });
    const items: PosCatalogueItem[] = res.items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      imageUrl: i.imageUrl,
      unitPrice: i.unitPrice === null ? null : Number(i.unitPrice),
      prepMinutes: i.prepMinutes ?? null,
      dietaryTags: i.dietaryTags ?? [],
      foodType: (i.foodType ?? null) as PosCatalogueItem['foodType'],
      category: i.category,
      subcategory: i.subcategory,
      hasVariants: i.hasVariants,
      variants: (i.variants ?? []).map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        unitPrice: Number(v.unitPrice),
        isDefault: v.isDefault,
        isActive: v.isActive,
      })),
      modifierGroups: (i.modifierGroups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        selection: g.selection,
        minSelections: g.minSelections,
        maxSelections: g.maxSelections,
        role: g.role,
        options: g.options.map((o) => ({
          id: o.id,
          name: o.name,
          priceDelta: Number(o.priceDelta),
          isActive: o.isActive,
        })),
      })),
      stations: i.stations ?? [],
      promotions: i.promotions,
    }));
    return { items, total: res.total };
  }
}
