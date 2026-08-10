'use client';

import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { formatElapsed, formatMoney, formatTime } from '@/lib/restaurant/labels';
import type { UnifiedOrderView } from '@/lib/restaurant/types';

import {
  PAYMENT_LABELS,
  PAYMENT_TONES,
  UNIFIED_CHANNEL_LABELS,
  UNIFIED_CHANNEL_TONES,
  UNIFIED_SOURCE_LABELS,
  UNIFIED_STATUS_LABELS,
  UNIFIED_STATUS_TONES,
} from './orders-labels';

/**
 * Right-side drawer that shows the full record for a row without
 * navigating away from the queue. Escape or backdrop click closes.
 *
 * Actions surface only endpoints that already exist on the backend
 * today. Advance / cancel / reprint flows for takeaway and 3rd-party
 * live in Slice E's follow-up wiring — for now this drawer is a
 * read-only inspector with navigation shortcuts to the full-page
 * workflows (bill, order-entry, POS).
 */
export function OrderDetailDrawer({
  order,
  onClose,
}: {
  order: UnifiedOrderView;
  onClose: () => void;
}) {
  const router = useRouter();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {UNIFIED_SOURCE_LABELS[order.source]}
              </span>
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
          <Section title="Customer">
            <Kv k="Name" v={order.customerName ?? '—'} />
            <Kv k="Phone" v={order.customerPhone ?? '—'} />
            <Kv k="Context" v={order.contextLabel ?? '—'} />
          </Section>

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

          <Section title="Items">
            {order.itemPreview.length === 0 ? (
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
            <Kv k="Items" v={String(order.itemCount)} />
            <Kv k="Total" v={order.total ? formatMoney(order.total) : '—'} strong />
          </Section>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border p-3">
          {order.channel === 'DINE_IN' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                router.push(
                  `/pos?mode=dine-in&sessionId=${encodeURIComponent(deriveSessionId(order))}`,
                )
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
              onClick={() =>
                router.push(
                  `/pos?mode=third-party&externalOrderId=${encodeURIComponent(order.id)}`,
                )
              }
            >
              Open inspector
            </Button>
          ) : null}
          {order.paymentStatus ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push('/bills')}
              title="Bill navigation lands in a follow-up slice"
              disabled
            >
              View Bill
            </Button>
          ) : null}
        </div>
      </div>
    </div>
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
