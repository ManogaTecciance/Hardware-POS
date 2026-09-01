'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getActiveCurrency } from '@/lib/tenant-money';
import { printReceipt } from '@/lib/receipt-print';
import { buildSampleBill } from '@/lib/settings/sample-bill';
import { detectBrowserLabel, renderBillTestStrip } from '@/lib/settings/bill-test-strip';
import type { DocumentSettings } from '@/lib/settings-api';
import { renderThermalBill } from '@/lib/thermal-bill';
import { BILL_GEOMETRY_LIMITS, resolveBillGeometry } from '@/lib/thermal-bill-geometry';

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
 *
 * D99 — and it is now where the roll is MEASURED, not only looked at. The
 * three numbers below the preview are the ones D73–D80 guessed at seven times
 * from a laptop; the calibration strip is how an operator answers them from
 * their own printer, in their own browser, in one page.
 */
export function BillPreviewTab({
  docs,
  set,
  showCalibration,
}: {
  docs: DocumentSettings;
  set: <K extends keyof DocumentSettings>(key: K, value: DocumentSettings[K]) => void;
  /** Resolved upstream (D28/D31) — this component decides nothing for itself. */
  showCalibration: boolean;
}) {
  const [lineCount, setLineCount] = React.useState(6);

  const geometry = React.useMemo(() => resolveBillGeometry(docs), [docs]);

  const html = React.useMemo(
    () => renderThermalBill(buildSampleBill(docs, getActiveCurrency(), lineCount)),
    [docs, lineCount],
  );

  /*
   * The strip says which browser produced it, because Chrome and Edge placing
   * the page box differently is the entire reason this tab has numbers on it,
   * and two strips on a counter are otherwise indistinguishable. Read at PRINT
   * time, not at render: `navigator` does not exist during the server render.
   */
  const printStrip = () => {
    printReceipt(
      renderBillTestStrip({ geometry, browserLabel: detectBrowserLabel(navigator.userAgent) }),
    );
  };

  /*
   * Numbers, never strings. The settings PUT validates these as numbers, and a
   * cleared field posting `''` is a 400 rather than a blank — so an empty box
   * keeps the last valid value and the operator sees the preview stop moving
   * instead of the save failing.
   */
  const setMm = (key: 'billPaperWidthMm' | 'billLeftInsetMm' | 'billRightInsetMm', raw: string) => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) return;
    set(key, n);
  };

  const limits = BILL_GEOMETRY_LIMITS;

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

      {showCalibration ? (
        <div className="space-y-3 rounded-xl border p-4">
          <div>
            <h3 className="text-sm font-medium">Roll calibration</h3>
            <p className="text-xs text-muted-foreground">
              These are the printer’s numbers, not the app’s — and they differ by browser, because
              Chrome and Edge place the page on the paper differently. Print the strip from every
              browser this till uses and keep the larger inset for each side.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="billPaperWidthMm">Paper width (mm)</Label>
              <Input
                id="billPaperWidthMm"
                type="number"
                className="w-36"
                min={limits.pageWidthMm.min}
                max={limits.pageWidthMm.max}
                value={docs.billPaperWidthMm}
                onChange={(e) => setMm('billPaperWidthMm', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billLeftInsetMm">Left inset (mm)</Label>
              <Input
                id="billLeftInsetMm"
                type="number"
                className="w-36"
                min={limits.insetMm.min}
                max={limits.insetMm.max}
                value={docs.billLeftInsetMm}
                onChange={(e) => setMm('billLeftInsetMm', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billRightInsetMm">Right inset (mm)</Label>
              <Input
                id="billRightInsetMm"
                type="number"
                className="w-36"
                min={limits.insetMm.min}
                max={limits.insetMm.max}
                value={docs.billRightInsetMm}
                onChange={(e) => setMm('billRightInsetMm', e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={printStrip}>
              Print calibration strip
            </Button>
          </div>

          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={docs.billFitToContent}
              onChange={(e) => set('billFitToContent', e.target.checked)}
            />
            {/* D77 — `@page{size}` is a request a driver can refuse, and a
                refused one is printed SCALED DOWN. Off is the way out of that
                without a deploy. */}
            <span>
              Print each bill as one page sized to its content. Turn this off if bills come out
              shrunk or split — that means the printer driver has a fixed maximum page length.
            </span>
          </label>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        This is the bill itself — the same template the till prints, at its real width of{' '}
        {geometry.pageWidthPx}px ({'≈'}
        {geometry.pageWidthMm}mm). Unsaved edits show here immediately; a field left blank simply
        does not print.
      </p>

      {/* Centred on the muted field so it reads as a slip of paper rather than
          as a page. Sized to the real receipt width — scaling it would make the
          one thing this tab exists to show, the fit, a lie. */}
      <div className="flex justify-center rounded-xl bg-muted p-6">
        <iframe
          title="Bill preview"
          srcDoc={html}
          className="h-[70vh] border-0 bg-white shadow-sm"
          style={{ width: geometry.pageWidthPx }}
        />
      </div>
    </div>
  );
}
