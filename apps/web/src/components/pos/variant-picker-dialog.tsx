'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { ClientProduct, ClientVariant } from '@/lib/catalog';
import { cn, formatMoney } from '@/lib/utils';

/**
 * D99 (1c.4) — choose which size / pack of a product to sell.
 *
 * A modal rather than a dropdown, for three reasons that all point the same way
 * on a till: the rows are finger-sized on a touchscreen, each one can carry its
 * own stock badge (a cashier must see "Medium — none left" *before* choosing,
 * not after), and `pos-retail-checkout` already suspends the barcode scanner
 * while a modal is open, so a scan cannot fire behind it.
 *
 * The restaurant customise dialog (D46) does the same job for menu items and was
 * the reference for the interaction. It is deliberately not reused: its types are
 * menu-item shaped and it carries modifier groups, which retail has no concept of.
 *
 * One tap adds. Select-then-confirm would be two taps for no gain — the caller
 * only opens this when there is a real choice to make, so the choice IS the
 * confirmation.
 */
export function VariantPickerDialog({
  open,
  product,
  currency,
  onPick,
  onClose,
}: {
  open: boolean;
  /** Null while closed, so the dialog unmounts its rows between openings. */
  product: ClientProduct | null;
  currency: string;
  onPick: (product: ClientProduct, variant: ClientVariant) => void;
  onClose: () => void;
}) {
  if (!product) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose an option"
      description={product.name}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div role="list" className="flex flex-col gap-1.5">
        {product.variants.map((v) => {
          // `stockState` is the server's classification (1b.1) — the till does
          // not re-derive "low" from a threshold, so a variant cannot be badged
          // differently here than on the product card.
          const out = v.stockState === 'OUT';
          const low = v.stockState === 'LOW';
          const untracked = v.stockState === 'UNTRACKED';

          return (
            <button
              key={v.id}
              type="button"
              role="listitem"
              disabled={out}
              onClick={() => onPick(product, v)}
              aria-label={`${v.name}, ${formatMoney(v.unitPrice, currency)}${out ? ', out of stock' : ''}`}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition',
                out
                  ? 'cursor-not-allowed border-border bg-muted/40 opacity-60'
                  : 'border-border hover:border-primary hover:bg-primary/5 active:bg-primary/10',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{v.name}</span>
                <span
                  className={cn(
                    'block text-[11px]',
                    out ? 'font-medium text-danger' : low ? 'font-medium text-warning' : 'text-muted-foreground',
                  )}
                >
                  {untracked
                    ? v.sku
                    : out
                      ? 'Out of stock'
                      : low
                        ? `Low stock — ${v.quantityOnHand} left`
                        : `${v.quantityOnHand} left`}
                </span>
              </span>
              {/* Per row, because sizes can differ in price and the card shows
                  only the cheapest (`displayPrice`). */}
              <span className="shrink-0 text-sm font-semibold text-primary">
                {formatMoney(v.unitPrice, currency)}
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

/**
 * Which variant a tap on the product card should add without prompting.
 *
 * Returns `null` when the operator has a genuine choice to make and the picker
 * should open instead.
 *
 * The ladder mirrors D46's preselect strategy on the restaurant side, minus the
 * edit-mode case retail does not have:
 *
 *   1. No variants — a plain product. Nothing to choose.
 *   2. Exactly one sellable variant — a one-row modal is a pointless tap.
 *   3. A variant marked `isDefault` — D45 exists for precisely this: "the POS
 *      quick-add path picks this one when the operator taps the product card
 *      without opening the variant picker."
 *   4. Otherwise the picker opens.
 *
 * Out-of-stock variants are excluded from 2 and 3. Quick-adding a size that
 * cannot be sold would put a line in the cart that the server refuses at
 * checkout, which is a worse outcome than one extra tap.
 *
 * Exported for testing: the ladder is the whole behaviour of this step, and it
 * is far easier to prove exhaustively as a function than through the DOM.
 */
export function quickAddVariant(product: ClientProduct): ClientVariant | null {
  if (product.variants.length === 0) return null;

  const sellable = product.variants.filter((v) => v.stockState !== 'OUT');
  if (sellable.length === 1) return sellable[0]!;

  const preferred = sellable.find((v) => v.isDefault);
  return preferred ?? null;
}

/** Whether tapping the card needs to ask, rather than just adding. */
export function needsVariantChoice(product: ClientProduct): boolean {
  return product.variants.length > 0 && quickAddVariant(product) === null;
}
