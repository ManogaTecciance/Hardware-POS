'use client';

/**
 * Retail reports (Phase 8, `8.2`).
 *
 * The shell owns the date range and the section list; each report is its own
 * section component — `8.3` sales by variant, `8.4` tax by rate, `8.5` margin,
 * `8.6` ageing — so a slow one never blocks the rest.
 *
 * Separate from `RestaurantReports` rather than a mode inside it: the two share
 * no figure. A restaurant closes out on covers, waiters and voids; a shop closes
 * out on sizes, margin and what has not moved. Merging them would mean a screen
 * that hides most of itself from whoever is looking at it.
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Session } from '@/lib/auth';
import {
  formatReportMoney,
  formatReportQuantity,
  salesByVariant,
  taxByRate,
  type TaxByRateReport,
  type VariantSalesReport,
} from '@/lib/reports';

/** Local date in the `YYYY-MM-DD` shape the report endpoints take. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface ReportRange {
  from: string;
  to: string;
}

const PRESETS: { label: string; range: () => ReportRange }[] = [
  {
    label: 'Today',
    range: () => ({ from: isoDate(new Date()), to: isoDate(new Date()) }),
  },
  {
    label: 'Last 7 days',
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 6);
      return { from: isoDate(from), to: isoDate(to) };
    },
  },
  {
    label: 'This month',
    range: () => {
      const now = new Date();
      return {
        from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: isoDate(now),
      };
    },
  },
];

export function RetailReports({ session }: { session: Session }) {
  const [range, setRange] = React.useState<ReportRange>(() => PRESETS[1]!.range());

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <Button key={p.label} variant="outline" size="sm" onClick={() => setRange(p.range())}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/*
        Sections mount here as each step lands. A section is added only when it
        has a screen behind it — listing them ahead of time, disabled, is the
        "reserved key with nothing behind it" shape D2 recorded and Phase 7 spent
        a step undoing.
      */}
      <RetailReportSections session={session} range={range} />
    </div>
  );
}

/**
 * The report sections themselves.
 *
 * Its own component so each step can add one without touching the shell's date
 * handling.
 */
function RetailReportSections({ session, range }: { session: Session; range: ReportRange }) {
  return (
    <div className="space-y-4">
      <SalesByVariantSection session={session} range={range} />
      <TaxByRateSection session={session} range={range} />
    </div>
  );
}

/** Load state for one section. `null` data is "not loaded yet", never "empty". */
interface SectionState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetch one report whenever the range changes.
 *
 * **Unresolved is its own state** (D28/D31): loading, failed and empty are three
 * different answers and the section renders each differently. A failed request
 * must never look like a shop that sold nothing.
 *
 * The `cancelled` flag drops the response of a superseded request — clicking
 * three presets quickly must leave the LAST range on screen, not whichever
 * request happened to return last.
 */
function useReport<T>(load: () => Promise<T>, deps: React.DependencyList): SectionState<T> {
  const [state, setState] = React.useState<SectionState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load this report.';
        setState({ data: null, error: message, loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** Card chrome shared by every section: title, and the three load states. */
function SectionShell<T>({
  title,
  description,
  state,
  empty,
  children,
}: {
  title: string;
  description: string;
  state: SectionState<T>;
  empty: string;
  children: (data: T) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        {state.loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : state.error ? (
          <p className="py-6 text-center text-sm text-destructive">{state.error}</p>
        ) : state.data ? (
          children(state.data)
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * `8.3` — what sold, by product and by size.
 *
 * The report a clothing buyer asks for first, and the reason Phase 1 froze
 * `productVariantId` onto every sale line: until now nothing read it.
 *
 * Money and quantities are rendered from the exact strings the server sent.
 * Nothing is summed here — the totals row is the server's own total, not the
 * sum of the visible rows, so the figure cannot disagree with the query.
 */
function SalesByVariantSection({ session, range }: { session: Session; range: ReportRange }) {
  const state = useReport<VariantSalesReport>(
    () => salesByVariant(session, range),
    [session, range.from, range.to],
  );

  return (
    <SectionShell
      title="Sales by variant"
      description="Which sizes and colours actually left the shelf. Best sellers first."
      state={state}
      empty="Nothing sold in this range."
    >
      {(report) =>
        report.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing sold in this range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-1 text-left">Product</th>
                  <th className="pb-1 text-left">Variant</th>
                  <th className="pb-1 text-left">SKU</th>
                  <th className="pb-1 text-right">Qty</th>
                  <th className="pb-1 text-right">Revenue</th>
                  <th className="pb-1 text-right">Tax</th>
                  <th className="pb-1 text-right">Discount</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr
                    key={`${row.productId ?? '-'}|${row.productVariantId ?? '-'}`}
                    className="border-t border-border"
                  >
                    <td className="py-1.5">{row.productName}</td>
                    {/* An em dash, not a blank cell: this product has no variants,
                        which is a fact about it rather than missing data. */}
                    <td className="py-1.5">{row.variantName ?? '—'}</td>
                    <td className="py-1.5 font-mono text-xs">{row.sku ?? '—'}</td>
                    <td className="py-1.5 text-right">{formatReportQuantity(row.quantitySold)}</td>
                    <td className="py-1.5 text-right">{formatReportMoney(row.revenue)}</td>
                    <td className="py-1.5 text-right">{formatReportMoney(row.tax)}</td>
                    <td className="py-1.5 text-right">{formatReportMoney(row.discount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-medium">
                  <td className="py-2" colSpan={3}>
                    Total
                  </td>
                  <td className="py-2 text-right">
                    {formatReportQuantity(report.totals.quantitySold)}
                  </td>
                  <td className="py-2 text-right">{formatReportMoney(report.totals.revenue)}</td>
                  <td className="py-2 text-right">{formatReportMoney(report.totals.tax)}</td>
                  <td className="py-2 text-right">{formatReportMoney(report.totals.discount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      }
    </SectionShell>
  );
}

/**
 * `8.4` — how much tax was charged at each rate.
 *
 * What a multi-rate shop files its return from, and what a single-rate shop
 * reconciles against its ledger. The figures are the server's allocation of each
 * sale's recorded tax, proven identical to the split printed on a customer's
 * receipt — so a manager holding both can tie them out.
 */
function TaxByRateSection({ session, range }: { session: Session; range: ReportRange }) {
  const state = useReport<TaxByRateReport>(
    () => taxByRate(session, range),
    [session, range.from, range.to],
  );

  return (
    <SectionShell
      title="Tax by rate"
      description="What was charged at each rate, and the net sales it was charged on."
      state={state}
      empty="No tax recorded in this range."
    >
      {(report) =>
        report.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tax recorded in this range.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-1 text-left">Rate</th>
                    <th className="pb-1 text-right">Net sales</th>
                    <th className="pb-1 text-right">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.ratePercent ?? 'unattributed'} className="border-t border-border">
                      <td className="py-1.5">{row.rateLabel}</td>
                      <td className="py-1.5 text-right">{formatReportMoney(row.taxable)}</td>
                      <td className="py-1.5 text-right">{formatReportMoney(row.tax)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border font-medium">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right">{formatReportMoney(report.totals.taxable)}</td>
                    <td className="py-2 text-right">{formatReportMoney(report.totals.tax)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {report.hasUnattributed ? (
              /*
                Said out loud, not buried in a row nobody reads twice. A tax
                figure with a silent hole in it is worse than no figure: the
                manager filing a return has to know which part of it cannot be
                substantiated from the sale.
              */
              <p className="text-xs text-muted-foreground">
                Some sales in this range were taken before the till recorded a tax rate on each
                line. Their tax is real and included in the total, but cannot be attributed to a
                rate — it is shown as <span className="font-medium">Rate not recorded</span>.
              </p>
            ) : null}
          </div>
        )
      }
    </SectionShell>
  );
}
