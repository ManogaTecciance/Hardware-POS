'use client';

import * as React from 'react';

import { formatMoney } from '@/lib/utils';
import { formatChartMonth } from '@/lib/suppliers/format';
import type { SupplierPurchasePoint } from '@/lib/suppliers/types';

/**
 * Compact monthly purchase-value bar chart. Rendered only when real
 * purchase-history data exists (never a decorative empty chart). Accessible:
 * a visually-hidden data table gives the same information to screen readers,
 * and bars are pure CSS so there's no reduced-motion concern.
 */
export function SupplierActivityChart({ points }: { points: SupplierPurchasePoint[] }) {
  const max = React.useMemo(() => Math.max(1, ...points.map((p) => p.value)), [points]);
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const avg = points.length ? total / points.length : 0;

  return (
    <figure className="space-y-3">
      <figcaption className="sr-only">
        Monthly purchase value over the last {points.length} months. Total {formatMoney(total)}, average{' '}
        {formatMoney(avg)} per month.
      </figcaption>

      <div className="flex items-end gap-2" role="presentation" style={{ height: 140 }}>
        {points.map((p) => {
          const h = Math.max(4, Math.round((p.value / max) * 120));
          return (
            <div key={p.month} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className="w-full rounded-t-md bg-[var(--sem-chart-1)] transition-[height]"
                style={{ height: h }}
                title={`${formatChartMonth(p.month)}: ${formatMoney(p.value)}`}
              />
              <span className="text-[10px] text-muted-foreground">{formatChartMonth(p.month)}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          Total purchased: <span className="font-medium text-foreground">{formatMoney(total)}</span>
        </span>
        <span>
          Average / month: <span className="font-medium text-foreground">{formatMoney(avg)}</span>
        </span>
        <span>
          Records: <span className="font-medium text-foreground">{points.length}</span>
        </span>
      </div>

      <table className="sr-only">
        <caption>Monthly purchase value</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <td>{formatChartMonth(p.month)}</td>
              <td>{formatMoney(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
