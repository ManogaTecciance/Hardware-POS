'use client';

import * as React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * D96 — what a bill contains, for the Layout tab of a workspace that prints one.
 *
 * Read-only on purpose. Every control the A4 Layout tab offers — page size,
 * orientation, margins, the SKU / discount / tax columns, signature fields,
 * page numbers — is structurally incapable of changing a thermal bill: the
 * columns are fixed, the totals rows appear when they are non-zero, and a
 * continuous roll has no page to lay out. Showing those controls here would be
 * offering settings that change nothing, which is worse than showing none.
 *
 * So the tab answers the question an operator actually has — "what will come
 * out of the printer, and where does each part come from?" — and names the tab
 * that edits each line.
 */
const ROWS: { part: string; from: string }[] = [
  { part: 'Logo, centred', from: 'Branding — replaces the business name when set' },
  { part: 'Business name', from: 'Business — printed when there is no logo' },
  { part: 'Address', from: 'Business' },
  { part: 'Phone and email', from: 'Business' },
  { part: 'VAT / tax number', from: 'Business' },
  { part: 'Served by, and the cashier who printed it', from: 'The session — not a setting' },
  { part: 'Date, bill number, table', from: 'The bill itself' },
  { part: 'Description · Qty · Amount', from: 'Fixed — the three columns a bill needs' },
  { part: 'Discount, service charge, packaging, tax', from: 'Charges — each row prints only when it is not zero' },
  { part: 'Total, paid, balance and the tender lines', from: 'The payment taken' },
  { part: 'Bill note', from: 'Business' },
  { part: 'Footer line', from: 'Business' },
];

export function BillStructureCard({ note }: { note: string | null }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>What prints on the bill</CardTitle>
        {note ? <p className="mt-0.5 text-sm text-muted-foreground">{note}</p> : null}
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border text-sm">
          {ROWS.map((row) => (
            <li key={row.part} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
              <span className="font-medium">{row.part}</span>
              <span className="text-xs text-muted-foreground">{row.from}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
