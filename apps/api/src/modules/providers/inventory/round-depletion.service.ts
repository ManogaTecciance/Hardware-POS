import { Injectable } from '@nestjs/common';
import { InventoryMode, Prisma, StockMovementReason } from '@hardware-pos/database';

import { StockLine } from '../provider.types';
import { InventoryProviderFactory } from './inventory-provider.factory';

/**
 * D65 — stock depletion for submitted order rounds (convergence plan §8.8,
 * Phase 8; Q4 resolved: SUBMIT time, with a compensating movement on void).
 *
 * This is the writer `StockMovementReason.ORDER_ROUND` waited for since it
 * was declared (plan defect D-5: restaurant stock was purchase-side only).
 * Runs INSIDE the caller's round transaction, so "the kitchen got the
 * ticket" and "the shelf count moved" cannot be observed apart — the same
 * reasoning as D53's food-always-reaches-the-kitchen.
 *
 * ## What depletes, by sellable kind
 *
 * - STOCK_ITEM       → itself, 1:1. The bottled drink in a restaurant.
 * - COMPOSED_ITEM /
 *   BUNDLE           → its `ProductComponent` rows, ONE level, at
 *                      `qty × component.quantity × (1 + wastageRate)`.
 *                      With NO recipe: NOTHING (deviation from the plan's
 *                      "absent = 1:1" note, recorded in D65) — its stock
 *                      number is a number nothing maintains and the POS
 *                      already shows it UNTRACKED (D62). Authoring a recipe
 *                      is the per-product opt-in §12.3.5 pairs with an
 *                      opening stock-take.
 * - SERVICE / TIME_SLOT / STAY_UNIT → nothing.
 *
 * The oversell guard is the provider's own (`reduceStock`): a round that
 * would take a tracked line below zero is REFUSED whole, exactly as a retail
 * sale is. The operator's recourse is a stock adjustment — the honest one.
 *
 * ## Ledger
 *
 * One `StockMovement` per (order item × depleted product): negative delta,
 * `reason: ORDER_ROUND`, `refType: 'RESTAURANT_ORDER_ITEM'`, `refId` the
 * item — so a void can restore EXACTLY what was taken even if the recipe has
 * been edited since (`restoreVoidedItem` mirrors the recorded movements, it
 * does not re-expand). `balanceAfter` is read back inside the transaction.
 */

export interface RoundDepletionItem {
  orderItemId: string;
  /** Null for unmigrated MENU_ITEM lines — nothing to deplete against. */
  productId: string | null;
  quantity: number;
}

interface DepletionTarget {
  productId: string;
  productName: string;
  quantity: number;
  trackInventory: boolean;
}

@Injectable()
export class RoundDepletionService {
  constructor(private readonly inventoryProviders: InventoryProviderFactory) {}

  async depleteSubmittedItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    items: RoundDepletionItem[],
    actorUserId: string,
  ): Promise<void> {
    const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is string => !!id))];
    if (productIds.length === 0) return;

    const provider = await this.inventoryProviders.forTenant(tenantId);
    // A tenant that tracks no stock depletes no stock — and gets no ledger
    // noise: an ORDER_ROUND row whose balanceAfter means nothing would teach
    // readers to distrust the ledger.
    if (provider.mode === InventoryMode.DISABLED) return;

    const products = await tx.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, name: true, type: true, sellableKind: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const composedIds = products
      .filter((p) => p.sellableKind === 'COMPOSED_ITEM' || p.sellableKind === 'BUNDLE')
      .map((p) => p.id);
    const components = composedIds.length
      ? await tx.productComponent.findMany({
          where: { tenantId, productId: { in: composedIds } },
        })
      : [];
    const componentsByProduct = new Map<string, typeof components>();
    for (const c of components) {
      const list = componentsByProduct.get(c.productId) ?? [];
      list.push(c);
      componentsByProduct.set(c.productId, list);
    }

    // Ingredient rows not already loaded (name + type for the stock lines).
    const ingredientIds = [
      ...new Set(components.map((c) => c.componentProductId).filter((id) => !productMap.has(id))),
    ];
    if (ingredientIds.length > 0) {
      const ingredients = await tx.product.findMany({
        where: { id: { in: ingredientIds }, tenantId },
        select: { id: true, name: true, type: true, sellableKind: true },
      });
      for (const p of ingredients) productMap.set(p.id, p);
    }

    for (const item of items) {
      if (!item.productId) continue;
      const product = productMap.get(item.productId);
      if (!product) continue; // resolved earlier in the tx; a miss is another tenant's id
      const targets = this.expand(item, product, componentsByProduct, productMap);
      const tracked = targets.filter((t) => t.trackInventory);
      if (tracked.length === 0) continue;

      const lines: StockLine[] = tracked.map((t) => ({
        productId: t.productId,
        // D99 — restaurant rounds deplete through components at product level
        // (D65). Variant-level depletion is a food-service question that the
        // retail work does not answer, so this stays null deliberately.
        productVariantId: null,
        productName: t.productName,
        quantity: t.quantity,
        trackInventory: true,
      }));
      await provider.reduceStock(tx, { tenantId, branchId }, lines);

      for (const target of tracked) {
        // Read back inside the transaction so balanceAfter is the post-
        // decrement number this movement actually produced.
        const after = await tx.product.findFirst({
          where: { id: target.productId, tenantId },
          select: { quantityOnHand: true },
        });
        await tx.stockMovement.create({
          data: {
            tenantId,
            branchId,
            productId: target.productId,
            delta: new Prisma.Decimal(-target.quantity),
            balanceAfter: after?.quantityOnHand ?? new Prisma.Decimal(0),
            reason: StockMovementReason.ORDER_ROUND,
            refType: 'RESTAURANT_ORDER_ITEM',
            refId: item.orderItemId,
            createdByUserId: actorUserId,
          },
        });
      }
    }
  }

  /**
   * Compensate a voided item by mirroring its RECORDED movements — not by
   * re-expanding the recipe, which may have changed since submit. Idempotent
   * per item: compensation rows carry refType 'RESTAURANT_ORDER_ITEM_VOID'
   * and the presence of any such row for the item short-circuits.
   */
  async restoreVoidedItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderItemId: string,
    actorUserId: string,
  ): Promise<void> {
    const taken = await tx.stockMovement.findMany({
      where: {
        tenantId,
        reason: StockMovementReason.ORDER_ROUND,
        refType: 'RESTAURANT_ORDER_ITEM',
        refId: orderItemId,
      },
    });
    if (taken.length === 0) return;

    const alreadyRestored = await tx.stockMovement.count({
      where: {
        tenantId,
        reason: StockMovementReason.ORDER_ROUND,
        refType: 'RESTAURANT_ORDER_ITEM_VOID',
        refId: orderItemId,
      },
    });
    if (alreadyRestored > 0) return;

    const provider = await this.inventoryProviders.forTenant(tenantId);
    const names = new Map(
      (
        await tx.product.findMany({
          where: { id: { in: [...new Set(taken.map((m) => m.productId))] }, tenantId },
          select: { id: true, name: true },
        })
      ).map((p) => [p.id, p.name]),
    );

    for (const movement of taken) {
      const qty = movement.delta.abs().toNumber();
      await provider.restoreStock(tx, { tenantId, branchId: movement.branchId }, [
        {
          productId: movement.productId,
          // D99 — mirrors the depletion above: product level, deliberately.
          productVariantId: null,
          productName: names.get(movement.productId) ?? movement.productId,
          quantity: qty,
          trackInventory: true,
        },
      ]);
      const after = await tx.product.findFirst({
        where: { id: movement.productId, tenantId },
        select: { quantityOnHand: true },
      });
      await tx.stockMovement.create({
        data: {
          tenantId,
          branchId: movement.branchId,
          productId: movement.productId,
          delta: movement.delta.abs(),
          balanceAfter: after?.quantityOnHand ?? new Prisma.Decimal(0),
          reason: StockMovementReason.ORDER_ROUND,
          refType: 'RESTAURANT_ORDER_ITEM_VOID',
          refId: orderItemId,
          createdByUserId: actorUserId,
        },
      });
    }
  }

  private expand(
    item: RoundDepletionItem,
    product: { id: string; name: string; type: string; sellableKind: string },
    componentsByProduct: Map<
      string,
      { componentProductId: string; quantity: Prisma.Decimal; wastageRate: Prisma.Decimal }[]
    >,
    productMap: Map<string, { id: string; name: string; type: string }>,
  ): DepletionTarget[] {
    if (product.sellableKind === 'STOCK_ITEM') {
      return [
        {
          productId: product.id,
          productName: product.name,
          quantity: item.quantity,
          // Same rule the whole stock layer uses: only 'Inventory' tracks.
          trackInventory: product.type === 'Inventory',
        },
      ];
    }
    if (product.sellableKind === 'COMPOSED_ITEM' || product.sellableKind === 'BUNDLE') {
      const recipe = componentsByProduct.get(product.id) ?? [];
      return recipe.map((c) => {
        const ingredient = productMap.get(c.componentProductId);
        // qty × per-unit quantity × (1 + wastage), rounded to the ledger's
        // 3-decimal stock precision.
        const quantity = new Prisma.Decimal(item.quantity)
          .mul(c.quantity)
          .mul(new Prisma.Decimal(1).plus(c.wastageRate))
          .toDecimalPlaces(3)
          .toNumber();
        return {
          productId: c.componentProductId,
          productName: ingredient?.name ?? c.componentProductId,
          quantity,
          trackInventory: ingredient?.type === 'Inventory',
        };
      });
    }
    // SERVICE / TIME_SLOT / STAY_UNIT — no stock claim.
    return [];
  }
}
