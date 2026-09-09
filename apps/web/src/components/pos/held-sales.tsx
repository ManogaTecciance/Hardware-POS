'use client';

/**
 * Hold and resume a basket — `8.8`.
 *
 * ## Nothing new is invented here
 *
 * A hold IS a draft. `SaleStatus.DRAFT`, `POST /sales/draft` and
 * `complete({ saleId })` have existed since Phase 1 and had no caller in the web
 * app: the till could create a draft it could never list, resume or discard.
 * This component is those three, and the checkout's existing completion path
 * finishes the job.
 *
 * ## Why resuming can change a quantity, and says so
 *
 * A held basket reserves nothing. That is deliberate — the goods stay on the
 * shelf and sellable, which is the point of putting a basket down rather than
 * ringing it up. So the last Medium in a fitting-room basket may genuinely be
 * gone an hour later, and the cart clamps the resumed line to what is actually
 * in stock.
 *
 * The alternative — resuming at the held quantity and failing at payment — is
 * worse: the cashier finds out with a customer in front of them. So the clamp is
 * reported the moment it happens, by name and by number.
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { cartLineKey, type CartItem } from '@/lib/cart';
import type { ClientProduct } from '@/lib/catalog';
import { type Session } from '@/lib/auth';
import { stockCap, usePosCart } from '@/lib/pos-cart';
import { createDraftSale, discardHeldSale, listHeldSales, toDraftLinePayload, type HeldSale } from '@/lib/held-sales';
import { formatMoney } from '@/lib/utils';

interface Props {
  session: Session;
  branchId: string | null;
  /** The catalog the checkout already loaded. Resume rebuilds lines from it. */
  products: ClientProduct[];
  items: CartItem[];
  customerId: string;
}

/**
 * "Hold" — put the current basket down.
 *
 * Disabled with a reason rather than hidden: a cashier who cannot hold needs to
 * know why, and a button that vanishes teaches nothing.
 */
export function HoldCartButton({ session, branchId, items, customerId }: Props) {
  const cart = usePosCart();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const hold = async () => {
    if (!branchId) return;
    setBusy(true);
    setError(null);
    try {
      await createDraftSale(session, {
        branchId,
        registerId: session.registerId ?? undefined,
        customerId: customerId || undefined,
        // Line discounts and notes travel with the basket: a price agreed
        // before the customer went to the fitting room should still be agreed
        // when they come back — through the sale's own mapper, so the basis
        // of a per-unit discount travels too.
        items: items.map(toDraftLinePayload),
      });
      cart.clearCart();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not hold this basket.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2"
        disabled={busy || items.length === 0 || !branchId}
        title={branchId ? 'Put this basket down and start a new one' : 'No active branch'}
        onClick={() => void hold()}
      >
        {busy ? 'Holding…' : 'Hold'}
      </Button>
    </div>
  );
}

/** "Held (n)" — the baskets waiting to be picked up again. */
export function HeldSalesButton({ session, branchId, products }: Props) {
  const cart = usePosCart();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [held, setHeld] = React.useState<HeldSale[] | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    listHeldSales(session, branchId ?? undefined)
      .then(setHeld)
      .catch(() => setHeld([]));
  }, [session, branchId]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const resume = (sale: HeldSale) => {
    // The cart is replaced, not merged: a resumed basket is the customer's
    // basket, and silently mixing it with whatever was on the screen would be
    // very hard to notice and very easy to charge for.
    cart.clearCart();

    const missing: string[] = [];
    const clamped: string[] = [];
    for (const line of sale.items) {
      const product = products.find((p) => p.id === line.productId);
      if (!product) {
        // The product was deactivated or removed while the basket was down.
        missing.push(line.productName);
        continue;
      }
      const variant = line.productVariantId
        ? (product.variants?.find((v) => v.id === line.productVariantId) ?? null)
        : null;
      if (line.productVariantId && !variant) {
        missing.push(line.variantNameSnapshot ?? line.productName);
        continue;
      }
      cart.addToCart(product, variant);
      cart.setQty(cartLineKey(product.id, variant?.id ?? null), line.quantity);

      // `setQty` caps at what is in stock, silently. The same function the cart
      // uses is asked here so the message reports the number the cashier will
      // actually see, rather than a guess about what the cart did.
      const cap = stockCap(product, variant);
      if (cap !== null && cap < line.quantity) {
        const name = variant ? `${product.name} (${variant.name})` : product.name;
        clamped.push(`${name} ${line.quantity} → ${Math.max(cap, 0)}`);
      }
    }

    if (sale.customerId) cart.setCustomerId(sale.customerId);
    setOpen(false);

    // Reported AFTER the cart is rebuilt, so the cashier reads it while looking
    // at what they actually got.
    const parts: string[] = [];
    if (missing.length) parts.push(`no longer available: ${missing.join(', ')}`);
    if (clamped.length) parts.push(`reduced to available stock: ${clamped.join(', ')}`);
    setNotice(
      parts.length
        ? `Resumed ${sale.saleNumber}, but ${parts.join('; ')}. Check the cart before taking payment.`
        : null,
    );
  };

  const discard = async (sale: HeldSale) => {
    // Awaited, not branched on a return value: the app's own confirm is a
    // promise (D141). The guard is otherwise the one that was here — the basket
    // number stays in the question, because "Discard held basket?" on a screen
    // listing four of them does not say which one is about to go.
    const ok = await confirm({
      title: `Discard held basket ${sale.saleNumber}?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Discard basket',
      tone: 'danger',
    });
    if (!ok) return;
    await discardHeldSale(session, sale.id);
    reload();
  };

  const count = held?.length ?? 0;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2"
        onClick={() => {
          reload();
          setOpen(true);
        }}
      >
        Held{count > 0 ? ` (${count})` : ''}
      </Button>

      {notice ? (
        <div className="mx-4 mb-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs">
          {notice}{' '}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <Dialog open={open} onClose={() => setOpen(false)} title="Held baskets">
        <div className="space-y-2">
          {held === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : held.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing is on hold. Use <span className="font-medium">Hold</span> to put a basket down
              without ringing it up — the stock stays on the shelf until it is paid for.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {held.map((sale) => (
                <li key={sale.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {sale.saleNumber}
                      {sale.customerName ? ` — ${sale.customerName}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(sale.createdAt).toLocaleString()} · {sale.items.length}{' '}
                      {sale.items.length === 1 ? 'line' : 'lines'} ·{' '}
                      {formatMoney(sale.subtotal)} · {sale.cashierName ?? 'unknown cashier'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {sale.items
                        .map(
                          (i) =>
                            `${i.quantity}× ${i.productName}${
                              i.variantNameSnapshot ? ` (${i.variantNameSnapshot})` : ''
                            }`,
                        )
                        .join(', ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => resume(sale)}>
                      Resume
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void discard(sale)}>
                      Discard
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}
