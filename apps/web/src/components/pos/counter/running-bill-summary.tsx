'use client';

import * as React from 'react';

import { saleLinePromotionNote } from '@hardware-pos/shared';

import { formatMoney } from '@/lib/restaurant/labels';

interface Props {
  itemCount: number;
  subtotal: number;
  itemDiscount: number;
  /** Promotions the cart earned automatically. Shown apart from a manual
   *  discount because nobody approved it — the offer did. */
  promotionDiscount: number;
  promotionName?: string | null;
  serviceCharge: number;
  taxAmount: number;
  servicePct: number;
  taxPct: number;
  total: number;
}

/**
 * The persistent running-bill card that lives above the Place Order CTA.
 * Kept as its own component so the layout hierarchy — subtotal → discount
 * → charges → **Total** — is enforced consistently even if the parent
 * rearranges surrounding sections.
 *
 * Total gets the strongest visual emphasis on the entire POS screen: big,
 * teal, tabular-nums.
 */
export function RunningBillSummary({
  itemCount,
  subtotal,
  itemDiscount,
  promotionDiscount,
  promotionName,
  serviceCharge,
  taxAmount,
  servicePct,
  taxPct,
  total,
}: Props) {
  return (
    <div className="space-y-1.5 border-t border-border bg-surface-muted/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Bill Summary
      </p>
      <Row label={`Items (${itemCount})`} value={formatMoney(subtotal)} />
      {itemDiscount > 0 ? (
        <Row
          label="Item discounts"
          value={`- ${formatMoney(itemDiscount)}`}
          tone="success"
        />
      ) : null}
      {promotionDiscount > 0 ? (
        <Row
          /*
           * Named AND labelled as a promotion. The bare offer name sat in the
           * same column as "Service charge" and "Tax" with nothing to say what
           * kind of line it was, so "Lunch 10%" read as a mystery deduction.
           *
           * `saleLinePromotionNote` rather than a local string: the receipt and
           * the A4 document already print "Promotion: {name}" through it, and
           * the till saying it differently is exactly the drift that helper
           * exists to prevent.
           */
          label={saleLinePromotionNote(promotionName) ?? 'Promotion'}
          value={`- ${formatMoney(promotionDiscount)}`}
          tone="success"
        />
      ) : null}
      {serviceCharge > 0 ? (
        <Row
          label={`Service charge (${servicePct}%)`}
          value={formatMoney(serviceCharge)}
        />
      ) : null}
      {taxAmount > 0 ? (
        <Row label={`Tax (${taxPct}%)`} value={formatMoney(taxAmount)} />
      ) : null}
      <div className="mt-2 flex items-center justify-between border-t border-dashed border-border pt-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Total
        </span>
        <span className="text-2xl font-bold tabular-nums text-primary">
          {formatMoney(total)}
        </span>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success';
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${tone === 'success' ? 'text-success' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}
