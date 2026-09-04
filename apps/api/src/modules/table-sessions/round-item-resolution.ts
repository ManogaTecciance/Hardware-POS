import { Prisma, RestaurantOrderItemSourceKind } from '@hardware-pos/database';

import { resolveMenuItemPricing } from '../menu/menu-item-pricing';
import type { RoundDepletionItem } from '../providers/inventory/round-depletion.service';
import {
  OrderItemInputDto,
  RestaurantOrderItemSourceKindDto,
} from './dto/table-sessions.dto';
import {
  MenuItemInactiveError,
  MenuItemNotFoundError,
  ModifierOptionNotOnItemError,
  ProductInactiveError,
  ProductNotFoundError,
  ProductSoldOutError,
  ProductVariantInactiveError,
  ProductVariantNotFoundError,
  VariantNotOnProductError,
  VariantSelectionRequiredError,
} from './table-sessions.errors';

/**
 * D46 round-item resolution, shared by BOTH intake paths (2026-08-18).
 *
 * This used to live inline in `submitRound`, which meant the takeaway path —
 * the same order machinery under a walk-in table — never got the widening:
 * it refused PRODUCT-sourced items outright and silently dropped modifiers.
 * The counter POS routes every mode through takeaway.create and, since the
 * catalogue convergence, sends PRODUCT lines — so a counter "dine-in" order
 * died at payment with "Takeaway does not yet accept Product-sourced items".
 * One resolver ends the divergence: both paths accept exactly the same
 * items, validate them identically, and snapshot them identically.
 *
 * The DTO carries two sources of round items: legacy MenuItem-sourced
 * (default) and Product-sourced (with an optional variant). Inputs are split
 * up front so each authority is loaded in its own tenant-scoped batch — one
 * query per source, not one per item — and rejected uniformly if the row is
 * missing / inactive / on the wrong parent.
 */

/** Everything a round-item row needs, resolved and snapshotted per input. */
export interface ResolvedRoundItem {
  /**
   * The loose `menuItemId` reference — a PRODUCT-sourced row stores the
   * Product id here, matching D46's decision to keep the legacy field for
   * reprint / order-detail / KOT lookup.
   */
  refId: string;
  refName: string;
  unitPrice: Prisma.Decimal;
  modifierTotal: Prisma.Decimal;
  sourceKind: RestaurantOrderItemSourceKind;
  productId: string | null;
  productVariantId: string | null;
  variantNameSnapshot: string | null;
  variantPriceSnapshot: Prisma.Decimal | null;
  quantity: number;
  specialInstructions: string | null;
  /** Frozen modifier snapshots — names and deltas as sold. */
  modifiers: {
    modifierOptionId: string;
    optionName: string;
    groupName: string;
    priceDelta: Prisma.Decimal;
  }[];
}

export async function resolveRoundItemInputs(
  tx: Prisma.TransactionClient,
  tenantId: string,
  items: OrderItemInputDto[],
): Promise<ResolvedRoundItem[]> {
  const sourceOf = (it: OrderItemInputDto): RestaurantOrderItemSourceKindDto =>
    it.sourceKind ?? RestaurantOrderItemSourceKindDto.MENU_ITEM;
  const menuInputs = items.filter(
    (it) => sourceOf(it) === RestaurantOrderItemSourceKindDto.MENU_ITEM,
  );
  const productInputs = items.filter(
    (it) => sourceOf(it) === RestaurantOrderItemSourceKindDto.PRODUCT,
  );

  const menuItemIds = menuInputs.map((it) => it.menuItemId!);
  const productIds = productInputs.map((it) => it.productId!);
  const productVariantIds = productInputs
    .map((it) => it.productVariantId)
    .filter((id): id is string => Boolean(id));

  // Three tenant-scoped batches in parallel. Each empty-set query is
  // skipped so an all-MENU_ITEM round never touches the Product tables
  // (and vice versa).
  const [menuItems, products, productVariants] = await Promise.all([
    menuItemIds.length
      ? tx.menuItem.findMany({
          where: { id: { in: menuItemIds }, tenantId },
          include: {
            modifierGroups: {
              select: { modifierGroupId: true },
            },
          },
        })
      : Promise.resolve([]),
    productIds.length
      ? tx.product.findMany({
          where: { id: { in: productIds }, tenantId },
          include: {
            modifierGroups: {
              select: { modifierGroupId: true },
            },
          },
        })
      : Promise.resolve([]),
    productVariantIds.length
      ? tx.productVariant.findMany({
          where: { id: { in: productVariantIds }, tenantId },
          include: {
            // Composed variant label ("Small / Red") for the snapshot
            // and for the KOT print. Falls back to SKU when the
            // variant was created without option values.
            optionValues: { include: { option: { select: { name: true } } } },
          },
        })
      : Promise.resolve([]),
  ]);

  const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));
  // D60 — transitional pricing for MENU_ITEM sources: placement override
  // ?? product price ?? frozen basePrice. See menu-item-pricing.ts.
  const menuItemPricing = await resolveMenuItemPricing(tx, tenantId, menuItemIds);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const variantMap = new Map(productVariants.map((v) => [v.id, v]));

  // Per-input resolution. Each iteration produces a `Resolved` record the
  // snapshot pass below turns into row fields — no second pass over the
  // inputs, no divergent field-population per source. This is where every
  // D46 rejection surfaces so no invalid row ever reaches a write path.
  type ResolvedMenuItem = { kind: 'MENU_ITEM'; menuItem: (typeof menuItems)[number] };
  type ResolvedProduct = {
    kind: 'PRODUCT';
    product: (typeof products)[number];
    variant: (typeof productVariants)[number] | null;
  };
  type Resolved = ResolvedMenuItem | ResolvedProduct;
  const resolved: Resolved[] = [];
  for (const inputItem of items) {
    const kind = sourceOf(inputItem);
    if (kind === RestaurantOrderItemSourceKindDto.MENU_ITEM) {
      const mi = menuItemMap.get(inputItem.menuItemId!);
      if (!mi) throw new MenuItemNotFoundError();
      if (!mi.isActive) throw new MenuItemInactiveError(mi.name);
      resolved.push({ kind: 'MENU_ITEM', menuItem: mi });
      continue;
    }
    const product = productMap.get(inputItem.productId!);
    if (!product) throw new ProductNotFoundError();
    if (!product.isActive) throw new ProductInactiveError(product.name);
    // D101 — POS greying is usability; this refusal is the rule. Sitting in
    // the SHARED resolver it covers both intake paths (dine-in rounds and
    // takeaway, which the counter routes every mode through). Out-of-stock
    // STOCK_ITEMs are deliberately not blocked here — oversell stays
    // permitted, unchanged.
    if (product.soldOutAt) throw new ProductSoldOutError(product.name);

    let variant: (typeof productVariants)[number] | null = null;
    if (inputItem.productVariantId) {
      variant = variantMap.get(inputItem.productVariantId) ?? null;
      if (!variant) throw new ProductVariantNotFoundError();
      if (variant.productId !== product.id) throw new VariantNotOnProductError();
      if (!variant.isActive) throw new ProductVariantInactiveError(variant.sku);
    } else {
      // No variantId sent. If the Product has any active variant, the
      // client MUST pick one — otherwise the price is ambiguous. We
      // ask the DB directly here (rather than trusting `hasVariants`)
      // because `hasVariants` can be true while every variant is
      // inactive, in which case the parent Product's `unitPrice`
      // legitimately applies.
      const activeVariantCount = await tx.productVariant.count({
        where: { productId: product.id, tenantId, isActive: true },
      });
      if (activeVariantCount > 0) {
        throw new VariantSelectionRequiredError(product.name);
      }
    }
    resolved.push({ kind: 'PRODUCT', product, variant });
  }

  // Modifier options (if any) — snapshot their names + deltas.
  const modifierOptionIds = items.flatMap(
    (it) => it.modifiers?.map((m) => m.modifierOptionId) ?? [],
  );
  const modifierOptions = modifierOptionIds.length
    ? await tx.modifierOption.findMany({
        where: { id: { in: modifierOptionIds }, tenantId },
        include: { group: { select: { id: true, name: true } } },
      })
    : [];
  const modifierMap = new Map(modifierOptions.map((o) => [o.id, o]));

  // D46 — service-layer guard: a modifier option must belong to a
  // group that is actually attached to the ordered item. A
  // ModifierGroup is intentionally reusable across items, so the DB
  // cannot express "this option is valid for THIS item only". Without
  // this check a client could send any tenant-scoped modifier and
  // its priceDelta would silently flow into the snapshot.
  for (let i = 0; i < items.length; i++) {
    const inputItem = items[i];
    if (!inputItem.modifiers?.length) continue;
    const r = resolved[i];
    const allowedGroupIds = new Set(
      r.kind === 'MENU_ITEM'
        ? r.menuItem.modifierGroups.map((g) => g.modifierGroupId)
        : r.product.modifierGroups.map((g) => g.modifierGroupId),
    );
    for (const m of inputItem.modifiers) {
      const opt = modifierMap.get(m.modifierOptionId);
      // A missing option is treated as "not on the item" — same
      // effect for the caller: refuse the round, refuse the write.
      if (!opt || !allowedGroupIds.has(opt.groupId)) {
        throw new ModifierOptionNotOnItemError();
      }
    }
  }

  // ── Snapshot pass: uniform fields per input ────────────────────────────
  return items.map((inputItem, i) => {
    const r = resolved[i];
    const selectedMods = (inputItem.modifiers ?? [])
      .map((m) => modifierMap.get(m.modifierOptionId))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    // D52: Decimal throughout. Summing price deltas as floats and
    // converting back drifts on fractional modifiers (0.10 + 0.20).
    const modifierTotal = selectedMods.reduce(
      (sum, m) => sum.plus(m.priceDelta),
      new Prisma.Decimal(0),
    );

    let refId: string;
    let refName: string;
    let unitPrice: Prisma.Decimal;
    let sourceKind: RestaurantOrderItemSourceKind;
    let productId: string | null;
    let productVariantId: string | null;
    let variantNameSnapshot: string | null;
    let variantPriceSnapshot: Prisma.Decimal | null;

    if (r.kind === 'MENU_ITEM') {
      refId = r.menuItem.id;
      refName = r.menuItem.name;
      // D60: the product price (with placement override) is authoritative
      // for a migrated item; basePrice only survives for unmigrated ones.
      const pricing = menuItemPricing.get(r.menuItem.id);
      // Same table, same tenant filter as the batch above — a miss here
      // is a bug, not a state, and pricing from a stale local copy would
      // put basePrice reads back outside menu-item-pricing.ts.
      if (!pricing) throw new MenuItemNotFoundError();
      unitPrice = pricing.unitPrice;
      sourceKind = RestaurantOrderItemSourceKind.MENU_ITEM;
      // Stamped so kitchen routing and reporting read ONE reference; the
      // convergence backfill does the same for historical rows.
      productId = pricing?.productId ?? null;
      productVariantId = null;
      variantNameSnapshot = null;
      variantPriceSnapshot = null;
    } else {
      refId = r.product.id;
      refName = r.product.name;
      sourceKind = RestaurantOrderItemSourceKind.PRODUCT;
      productId = r.product.id;
      if (r.variant) {
        unitPrice = r.variant.unitPrice;
        productVariantId = r.variant.id;
        // Compose "Small / Red"; fall back to SKU when the variant
        // has no option values (a wizard shortcut path). Mirrors the
        // pos-catalogue variant-name convention so what the operator
        // saw in the picker matches what prints on the KOT.
        const composed = r.variant.optionValues
          .map((ov) => ov.option?.name ?? '')
          .filter(Boolean)
          .join(' / ');
        variantNameSnapshot = composed.length > 0 ? composed : r.variant.sku;
        variantPriceSnapshot = r.variant.unitPrice;
      } else {
        unitPrice = r.product.unitPrice;
        productVariantId = null;
        variantNameSnapshot = null;
        variantPriceSnapshot = null;
      }
    }

    return {
      refId,
      refName,
      unitPrice,
      modifierTotal,
      sourceKind,
      productId,
      productVariantId,
      variantNameSnapshot,
      variantPriceSnapshot,
      quantity: inputItem.quantity,
      specialInstructions: inputItem.specialInstructions ?? null,
      modifiers: selectedMods.map((m) => ({
        modifierOptionId: m.id,
        optionName: m.name,
        groupName: m.group.name,
        priceDelta: m.priceDelta,
      })),
    };
  });
}

/**
 * Write the resolved items (and their frozen modifier snapshots) onto a
 * round, returning the D65 depletion inputs. Both intake paths write the
 * exact same rows — that is the point.
 */
export async function writeRoundItems(
  tx: Prisma.TransactionClient,
  ids: { tenantId: string; orderId: string; roundId: string },
  resolvedItems: ResolvedRoundItem[],
): Promise<{ depletionItems: RoundDepletionItem[] }> {
  const depletionItems: RoundDepletionItem[] = [];
  for (const r of resolvedItems) {
    const item = await tx.restaurantOrderItem.create({
      data: {
        tenantId: ids.tenantId,
        orderId: ids.orderId,
        roundId: ids.roundId,
        menuItemId: r.refId,
        menuItemName: r.refName,
        unitPrice: r.unitPrice,
        modifierTotal: r.modifierTotal,
        quantity: new Prisma.Decimal(r.quantity),
        specialInstructions: r.specialInstructions,
        status: 'SENT',
        sourceKind: r.sourceKind,
        productId: r.productId,
        productVariantId: r.productVariantId,
        variantNameSnapshot: r.variantNameSnapshot,
        variantPriceSnapshot: r.variantPriceSnapshot,
      },
    });
    depletionItems.push({
      orderItemId: item.id,
      productId: r.productId,
      quantity: r.quantity,
    });
    for (const mod of r.modifiers) {
      await tx.restaurantOrderItemModifier.create({
        data: {
          tenantId: ids.tenantId,
          itemId: item.id,
          modifierOptionId: mod.modifierOptionId,
          optionName: mod.optionName,
          groupName: mod.groupName,
          priceDelta: mod.priceDelta,
        },
      });
    }
  }
  return { depletionItems };
}
