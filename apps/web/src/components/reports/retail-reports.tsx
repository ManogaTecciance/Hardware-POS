'use client';

/**
 * Retail reports (Phase 8, `8.2`).
 *
 * The shell. Each report lands in its own step — `8.3` sales by variant, `8.4`
 * tax by rate, `8.5` margin, `8.6` ageing — so this file owns the date range and
 * the section list, and nothing else.
 *
 * Separate from `RestaurantReports` rather than a mode inside it: the two share
 * no figure. A restaurant closes out on covers, waiters and voids; a shop closes
 * out on sizes, margin and what has not moved. Merging them would mean a screen
 * that hides most of itself from whoever is looking at it.
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Session } from '@/lib/auth';

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
        `8.3`–`8.6` mount their sections here. Listing them now, disabled, would
        promise screens that do not exist — the "reserved key with nothing behind
        it" shape D2 recorded and Phase 7 spent a step undoing.
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
  void session;
  void range;
  return (
    <Card>
      <CardContent className="py-12 text-center text-sm text-muted-foreground">
        No reports yet.
      </CardContent>
    </Card>
  );
}
