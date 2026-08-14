import { Prisma } from '@hardware-pos/database';

/**
 * D60 — the transitional pricing rule for a MENU_ITEM-sourced order line.
 *
 * `MenuItem` is frozen (writes 410), so `basePrice` can no longer be edited —
 * the product price is authoritative and a placement may override it:
 *
 *     price = CatalogueEntry.priceOverride ?? Product.unitPrice
 *
 * falling back to the frozen `basePrice` only for an item the convergence
 * backfill has not touched (no product link at all). At backfill time the
 * three agree by construction — the override is written only where basePrice
 * differed from the product — so nothing changes on the day; afterwards a
 * product price edit reaches menu-item orders too, which is the point (plan
 * P1: one authority per fact).
 *
 * This module is deliberately the ONLY place outside the read-only legacy
 * menu endpoints that touches `basePrice`; `catalogue-single-authority.spec`
 * pins that as an exact file set.
 */

export interface ResolvedMenuItemPricing {
  menuItem: {
    id: string;
    name: string;
    basePrice: Prisma.Decimal;
    sectionId: string;
    isActive: boolean;
  };
  /** The linked product (native link, or the one the backfill created). */
  productId: string | null;
  unitPrice: Prisma.Decimal;
}

export async function resolveMenuItemPricing(
  tx: Prisma.TransactionClient,
  tenantId: string,
  menuItemIds: readonly string[],
): Promise<Map<string, ResolvedMenuItemPricing>> {
  if (menuItemIds.length === 0) return new Map();

  const menuItems = await tx.menuItem.findMany({
    where: { id: { in: [...menuItemIds] }, tenantId },
    select: {
      id: true,
      name: true,
      basePrice: true,
      sectionId: true,
      isActive: true,
      productId: true,
      migratedProductId: true,
    },
  });

  const productIds = [
    ...new Set(
      menuItems.map((mi) => mi.productId ?? mi.migratedProductId).filter((id): id is string => !!id),
    ),
  ];
  const [products, entries] = await Promise.all([
    productIds.length
      ? tx.product.findMany({
          where: { id: { in: productIds }, tenantId },
          select: { id: true, unitPrice: true },
        })
      : Promise.resolve([]),
    productIds.length
      ? tx.catalogueEntry.findMany({
          where: { tenantId, productId: { in: productIds } },
          select: { sectionId: true, productId: true, priceOverride: true },
        })
      : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const entryByPlacement = new Map(entries.map((e) => [`${e.sectionId}:${e.productId}`, e]));

  const resolved = new Map<string, ResolvedMenuItemPricing>();
  for (const mi of menuItems) {
    const linkId = mi.productId ?? mi.migratedProductId;
    const product = linkId ? productById.get(linkId) : undefined;
    const entry = linkId ? entryByPlacement.get(`${mi.sectionId}:${linkId}`) : undefined;
    resolved.set(mi.id, {
      menuItem: mi,
      productId: product ? product.id : null,
      unitPrice: entry?.priceOverride ?? product?.unitPrice ?? mi.basePrice,
    });
  }
  return resolved;
}
