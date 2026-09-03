'use client';

import { Receipt, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { BillDialog } from '@/components/restaurant/billing/bill-dialog';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { useAuth } from '@/lib/auth';
import { restaurantOrders } from '@/lib/restaurant/api';
import { formatElapsed, formatMoney, formatTime } from '@/lib/restaurant/labels';
import type { UnifiedOrderDetail, UnifiedOrderView } from '@/lib/restaurant/types';
import { useOrientation } from '@/lib/use-viewport';

import {
  PAYMENT_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_TONES,
  UNIFIED_CHANNEL_LABELS,
  UNIFIED_CHANNEL_TONES,
  UNIFIED_SOURCE_LABELS,
  UNIFIED_STATUS_LABELS,
  UNIFIED_STATUS_TONES,
} from './orders-labels';

/**
 * Detail panel that shows the full record for a row without navigating away
 * from the queue. Escape or backdrop click closes.
 *
 * Adaptive container: on portrait viewports (tablet portrait, phone) the
 * bespoke right-side drawer capped at 420px leaves the underlying list
 * half-clipped and eats readable width — we render a full-height <Sheet>
 * anchored to the bottom instead, which is the ergonomic pattern for a
 * one-handed hold. On landscape and desktop we keep the drawer so the
 * operator can keep an eye on the queue while inspecting a row.
 *
 * Actions surface only endpoints that already exist on the backend today.
 * Advance / cancel / reprint flows for takeaway and 3rd-party live in
 * Slice E's follow-up wiring — for now this panel is a read-only inspector
 * with navigation shortcuts to the full-page workflows (bill, order-entry,
 * POS).
 *
 * The queue row is rendered instantly; the full record (line prices, money
 * breakdown, payments, delivery destination, timeline) arrives from the
 * detail endpoint and upgrades the sections in place. A failed or missing
 * detail degrades back to the row — the drawer never errors over data it
 * already has.
 */
export function OrderDetailDrawer({
  order,
  branchId,
  onClose,
}: {
  order: UnifiedOrderView;
  branchId: string;
  onClose: () => void;
}) {
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const { session } = useAuth();

  const [detail, setDetail] = React.useState<UnifiedOrderDetail | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    // Reset when the operator clicks a different row while the drawer is
    // open — order A's prices must not sit under order B's header.
    setDetail(null);
    if (!session) return;
    restaurantOrders
      .detail(session, branchId, order.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, branchId, order.id]);

  // Escape closes the landscape drawer. The Sheet primitive owns its own
  // Escape handler so we only wire this for the drawer branch — running
  // both would double-fire onClose.
  React.useEffect(() => {
    if (isPortrait) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isPortrait]);

  if (isPortrait) {
    return (
      <Sheet open onClose={onClose} height="full" title={`#${order.orderNumber}`}>
        <OrderDetailBody order={order} detail={detail} onClose={onClose} />
      </Sheet>
    );
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close order details"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/50"
      />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-bold">#{order.orderNumber}</p>
              <StatusBadge
                label={UNIFIED_CHANNEL_LABELS[order.channel]}
                tone={UNIFIED_CHANNEL_TONES[order.channel]}
              />
              {/* Partner chip only: on first-party channels the source
                  repeats the channel badge and is dropped; on 3rd-party it
                  names the partner. */}
              {order.channel === 'THIRD_PARTY' ? (
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  via {UNIFIED_SOURCE_LABELS[order.source]}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Created {formatElapsed(order.createdAt)} · {formatTime(order.createdAt)}
              {order.pickupAt ? ` · Pickup ${formatTime(order.pickupAt)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <OrderDetailSections order={order} detail={detail} />
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border p-3">
          <OrderDetailActions order={order} />
        </div>
      </div>
    </div>
  );
}

/**
 * Body used by both the portrait Sheet and the landscape drawer. The Sheet
 * already owns the title/close chrome; on portrait we also want the channel
 * badges and timestamp visible, so we include them as an internal header
 * strip. On landscape the outer drawer owns its own header (with the same
 * badges) and we skip the strip.
 */
function OrderDetailBody({
  order,
  detail,
  onClose,
}: {
  order: UnifiedOrderView;
  detail: UnifiedOrderDetail | null;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <StatusBadge
          label={UNIFIED_CHANNEL_LABELS[order.channel]}
          tone={UNIFIED_CHANNEL_TONES[order.channel]}
        />
        {/* Partner chip only — see the landscape header. */}
        {order.channel === 'THIRD_PARTY' ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            via {UNIFIED_SOURCE_LABELS[order.source]}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Created {formatElapsed(order.createdAt)} · {formatTime(order.createdAt)}
          {order.pickupAt ? ` · Pickup ${formatTime(order.pickupAt)}` : ''}
        </span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto">
        <OrderDetailSections order={order} detail={detail} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <OrderDetailActions order={order} onDone={onClose} />
      </div>
    </div>
  );
}

function OrderDetailSections({
  order,
  detail,
}: {
  order: UnifiedOrderView;
  detail: UnifiedOrderDetail | null;
}) {
  const nz = (v: string) => Number(v) !== 0;
  return (
    <>
      <Section title="Customer">
        <Kv k="Name" v={order.customerName ?? '—'} />
        <Kv k="Phone" v={order.customerPhone ?? '—'} />
        {/*
          No third row for takeaway: contextLabel is the customer's name
          again there, and "Context: lahiru" under "Name: lahiru" told the
          operator nothing. The other channels get the label under the name
          it actually carries.
        */}
        {order.channel === 'DINE_IN' ? <Kv k="Table" v={order.contextLabel ?? '—'} /> : null}
        {order.channel === 'THIRD_PARTY' ? (
          <Kv k="Reference" v={order.contextLabel ?? '—'} />
        ) : null}
      </Section>

      {detail?.deliveryAddress ? (
        <Section title="Deliver to">
          <p className="whitespace-pre-wrap text-sm font-medium">{detail.deliveryAddress}</p>
        </Section>
      ) : null}
      {detail?.notes ? (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{detail.notes}</p>
        </Section>
      ) : null}

      <Section title="Status">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <p className="text-[11px] text-muted-foreground">Order</p>
            <StatusBadge
              label={UNIFIED_STATUS_LABELS[order.unifiedStatus]}
              tone={UNIFIED_STATUS_TONES[order.unifiedStatus]}
            />
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Payment</p>
            {order.paymentStatus ? (
              <StatusBadge
                label={PAYMENT_LABELS[order.paymentStatus]}
                tone={PAYMENT_TONES[order.paymentStatus]}
              />
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>
        </div>
      </Section>

      {/* "Created" renders from the row, so the section never waits on the
          fetch; the recorded transitions join it when the detail lands. */}
      <Section title="Timeline">
        <Kv k="Created" v={formatTime(order.createdAt)} />
        {detail?.timeline.map((t, i) => (
          <Kv key={`${t.at}-${i}`} k={UNIFIED_STATUS_LABELS[t.status]} v={formatTime(t.at)} />
        ))}
      </Section>

      <Section title="Items">
        {detail?.items.length ? (
          <ul className="space-y-2">
            {detail.items.map((it, i) => (
              <li
                key={`${order.id}-d-${i}`}
                className="rounded-md border border-border p-2 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <span>
                    {it.quantity}× {it.name}
                    {it.variantName ? ` (${it.variantName})` : ''}
                  </span>
                  <span className="font-medium tabular-nums">{formatMoney(it.lineTotal)}</span>
                </div>
                {Number(it.quantity) !== 1 ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatMoney(it.unitPrice)} each
                  </p>
                ) : null}
                {it.modifiers.length > 0 ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {it.modifiers.map((m) => m.optionName).join(', ')}
                  </p>
                ) : null}
                {it.specialInstructions ? (
                  <p className="mt-0.5 text-xs italic text-muted-foreground">
                    {it.specialInstructions}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : order.itemPreview.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No per-item breakdown available for this row.
          </p>
        ) : (
          <ul className="space-y-2">
            {order.itemPreview.map((it, i) => (
              <li
                key={`${order.id}-i-${i}`}
                className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
              >
                <span>
                  {it.qty}× {it.name}
                </span>
              </li>
            ))}
            {order.itemCount > order.itemPreview.length ? (
              <p className="text-xs text-muted-foreground">
                +{order.itemCount - order.itemPreview.length} more
              </p>
            ) : null}
          </ul>
        )}
      </Section>

      <Section title="Financials">
        {detail?.financials ? (
          <>
            <Kv k="Subtotal" v={formatMoney(detail.financials.subtotal)} />
            {nz(detail.financials.totalDiscount) ? (
              <Kv k="Discount" v={`− ${formatMoney(detail.financials.totalDiscount)}`} />
            ) : null}
            {nz(detail.financials.serviceChargeAmount) ? (
              <Kv k="Service charge" v={formatMoney(detail.financials.serviceChargeAmount)} />
            ) : null}
            {nz(detail.financials.packagingCharge) ? (
              <Kv k="Packaging" v={formatMoney(detail.financials.packagingCharge)} />
            ) : null}
            {nz(detail.financials.taxAmount) ? (
              <Kv k="Tax" v={formatMoney(detail.financials.taxAmount)} />
            ) : null}
            <Kv k="Total" v={formatMoney(detail.financials.total)} strong />
            {detail.payments.map((p, i) => (
              <Kv
                key={`${p.at}-${i}`}
                k={`Paid · ${PAYMENT_METHOD_LABELS[p.method]}`}
                v={formatMoney(p.amount)}
              />
            ))}
            {nz(detail.financials.balanceAmount) ? (
              <Kv k="Balance due" v={formatMoney(detail.financials.balanceAmount)} />
            ) : null}
          </>
        ) : (
          <>
            <Kv k="Items" v={String(order.itemCount)} />
            <Kv k="Total" v={order.total ? formatMoney(order.total) : '—'} strong />
          </>
        )}
      </Section>
    </>
  );
}

function OrderDetailActions({
  order,
  onDone,
}: {
  order: UnifiedOrderView;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const [billFor, setBillFor] = React.useState<string | null>(null);
  const go = (href: string) => {
    router.push(href);
    onDone?.();
  };
  return (
    <>
      {order.channel === 'DINE_IN' ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            go(`/pos?mode=dine-in&sessionId=${encodeURIComponent(deriveSessionId(order))}`)
          }
          disabled={!deriveSessionId(order)}
          title={
            deriveSessionId(order)
              ? undefined
              : 'Session id not available from this row'
          }
        >
          Open in POS
        </Button>
      ) : null}
      {order.channel === 'THIRD_PARTY' ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => go(`/pos?mode=third-party&externalOrderId=${encodeURIComponent(order.id)}`)}
        >
          Open inspector
        </Button>
      ) : null}
      {billFor && session ? (
        <BillDialog
          session={session}
          saleId={billFor}
          title={order.orderNumber}
          onClose={() => setBillFor(null)}
        />
      ) : null}
      {/*
        * D83 — the follow-up slice this button was waiting for. It used to
        * be disabled with "Bill navigation lands in a follow-up slice",
        * because the queue row carried a payment status but not the id of
        * the sale it belonged to. It does now, so the bill opens in place —
        * read it, reprint it, without leaving the queue.
        *
        * Absent rather than disabled when there is no sale: a third-party
        * order settles on the partner's side and never has one, and a
        * greyed-out button invites people to keep trying it.
        */}
      {order.saleId ? (
        <Button
          size="sm"
          variant="outline"
          leftIcon={<Receipt className="h-4 w-4" />}
          onClick={() => setBillFor(order.saleId!)}
        >
          View bill
        </Button>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Kv({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={strong ? 'font-bold' : 'font-medium'}>{v}</span>
    </div>
  );
}

// Placeholder: `UnifiedOrderView` does not carry sessionId today.
// A future slice adds it to the view for the Dine-In deep link.
function deriveSessionId(_order: UnifiedOrderView): string {
  return '';
}
