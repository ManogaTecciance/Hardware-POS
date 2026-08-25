'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getActiveCurrency } from '@/lib/tenant-money';
import { printReceipt } from '@/lib/receipt-print';
import { buildSampleBill } from '@/lib/settings/sample-bill';
import type { DocumentSettings } from '@/lib/settings-api';
import { RECEIPT_WIDTH_PX, renderThermalBill } from '@/lib/thermal-bill';

/**
 * D96 — the Preview tab for a workspace that prints bills.
 *
 * Rendered CLIENT-side from `renderThermalBill`, which is the function the till
 * actually prints from — the same one behind the bill screen, the bill dialog
 * and every reprint. That is the whole point of the tab: a preview produced by
 * a second template is a picture of something else, and this product already
 * carries a comment explaining why there is only one ("two hand-written receipt
 * templates is how a tenant ends up with a logo on one bill and not the
 * other").
 *
 * It takes the tab's UNSAVED `docs` object, so an operator sees the effect of a
 * change before deciding to keep it. That works because `renderThermalBill`'s
 * profile parameter is exactly the `DocumentSettings` type this screen edits.
 */
export function BillPreviewTab({ docs }: { docs: DocumentSettings }) {
  const [lineCount, setLineCount] = React.useState(6);

  const html = React.useMemo(
    () => renderThermalBill(buildSampleBill(docs, getActiveCurrency(), lineCount)),
    [docs, lineCount],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Sample rows</Label>
          <Select
            value={String(lineCount)}
            onChange={(e) => setLineCount(Number(e.target.value))}
            className="w-40"
          >
            {[3, 6, 12, 30].map((n) => (
              <option key={n} value={n}>
                {n} {n >= 30 ? '(long bill)' : ''}
              </option>
            ))}
          </Select>
        </div>
        {/*
          * Prints through the same hidden-iframe path the till uses (D82), not
          * `window.open`: a popup preview is the one the browser refuses to
          * close afterwards, which took four attempts to learn the first time.
          */}
        <Button variant="outline" onClick={() => void printReceipt(html)}>
          Print / Save as PDF
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        This is the bill itself — the same template the till prints, at its real width of{' '}
        {RECEIPT_WIDTH_PX}px ({'≈'}78mm). Unsaved edits show here immediately; a field left
        blank simply does not print.
      </p>

      {/* Centred on the muted field so it reads as a slip of paper rather than
          as a page. Sized to the real receipt width — scaling it would make the
          one thing this tab exists to show, the fit, a lie. */}
      <div className="flex justify-center rounded-xl bg-muted p-6">
        <iframe
          title="Bill preview"
          srcDoc={html}
          className="h-[70vh] border-0 bg-white shadow-sm"
          style={{ width: RECEIPT_WIDTH_PX }}
        />
      </div>
    </div>
  );
}
