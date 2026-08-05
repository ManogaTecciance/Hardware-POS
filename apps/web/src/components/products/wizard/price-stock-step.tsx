'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ProductPresentation } from '@/lib/products/product-presentation';
import type { ManagedProduct } from '@/lib/products-api';

import { Field, InfoPanel, StepHeader } from './fields';
import type { FieldErrors, FormState, SetField } from './types';

/**
 * Step 2 — the money half of the QuickBooks Products & Services template:
 * sales price, purchase description/cost, and (for Inventory items) quantity
 * on hand, its as-of date, and the reorder point. The three QBO accounts are
 * assigned automatically during sync and shown read-only.
 */
export function PriceStockStep({
  form,
  set,
  errors,
  stockLocked,
  product,
  presentation,
}: {
  form: FormState;
  set: SetField;
  errors: FieldErrors;
  stockLocked: boolean;
  /** Existing product (edit mode) — source of the read-only account names. */
  product?: ManagedProduct;
  /** Mode-aware flags; the only thing that varies per tenant configuration. */
  presentation: ProductPresentation;
}) {
  // Both must hold: the item must be stock-shaped AND the tenant must track stock.
  const isInventory = form.type === 'Inventory' && presentation.showStockControls;

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow="Step 2 of 3"
        title="Price and stock"
        description="What customers pay, what you pay your suppliers, and the stock you hold."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Sales price/rate"
          htmlFor="field-price"
          required
          error={errors.unitPrice}
          help="The price or rate your customers will pay."
        >
          <Input
            id="field-price"
            inputMode="decimal"
            value={form.unitPrice}
            onChange={(e) => set('unitPrice', e.target.value)}
            placeholder="0.00"
            aria-invalid={!!errors.unitPrice || undefined}
          />
        </Field>

        <Field
          label="Purchase cost"
          htmlFor="field-cost"
          help="The price you pay when you buy this from your suppliers."
        >
          <Input
            id="field-cost"
            inputMode="decimal"
            value={form.costPrice}
            onChange={(e) => set('costPrice', e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field
          label="Purchase description"
          htmlFor="field-purchase-description"
          help="What vendors see when you purchase this product."
          className="sm:col-span-2"
        >
          <Textarea
            id="field-purchase-description"
            value={form.purchaseDescription}
            onChange={(e) => set('purchaseDescription', e.target.value)}
            placeholder="Optional purchase description"
            rows={2}
          />
        </Field>
      </div>

      {isInventory ? (
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-sm font-semibold">Inventory</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Quantity on hand"
              htmlFor="field-qty"
              hint={stockLocked ? 'Managed by QuickBooks' : undefined}
            >
              <Input
                id="field-qty"
                inputMode="decimal"
                value={form.quantityOnHand}
                onChange={(e) => set('quantityOnHand', e.target.value)}
                disabled={stockLocked}
              />
            </Field>

            <Field
              label="Quantity as of date"
              htmlFor="field-qty-date"
              help="The date this quantity was counted."
            >
              <Input
                id="field-qty-date"
                type="date"
                value={form.quantityAsOfDate}
                onChange={(e) => set('quantityAsOfDate', e.target.value)}
                disabled={stockLocked}
              />
            </Field>

            <Field
              label="Reorder point"
              htmlFor="field-reorder"
              help="We'll flag the product as low stock at or below this quantity."
            >
              <Input
                id="field-reorder"
                inputMode="decimal"
                value={form.reorderLevel}
                onChange={(e) => set('reorderLevel', e.target.value)}
                placeholder="e.g. 5"
              />
            </Field>
          </div>
        </div>
      ) : (
        <InfoPanel>
          {presentation.stockTrackingNote
            ? `${presentation.stockTrackingNote} for this business — quantity fields are not applicable.`
            : form.type === 'Service'
              ? 'Services have no stock — quantity fields are not applicable.'
              : 'Non-Inventory products are not stock-tracked — quantity fields are not applicable.'}
        </InfoPanel>
      )}

      {presentation.showExternalAccounts ? (
        <div className="space-y-2 rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-sm font-semibold">QuickBooks accounts</h3>
          <p className="text-xs text-muted-foreground">
            Assigned automatically when the product syncs to QuickBooks.
          </p>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Income account</dt>
              <dd className="mt-0.5 font-medium">{product?.incomeAccount ?? 'Auto-assigned'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expense account</dt>
              <dd className="mt-0.5 font-medium">{product?.expenseAccount ?? 'Auto-assigned'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Inventory asset account</dt>
              <dd className="mt-0.5 font-medium">
                {isInventory ? (product?.inventoryAssetAccount ?? 'Auto-assigned') : '—'}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
