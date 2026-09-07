'use client';

/**
 * D104 Part 3 — the barcode audit and reissue pass (Phase 5, `5.9`).
 *
 * The screen exists because the problem is invisible without it. The pilot's
 * barcodes are the right length, in the right GS1 range, and 18 of 20 carry a
 * check digit that no scanner or label renderer will accept. Nothing looks
 * wrong until a label fails to render, and then it reads as a rendering bug.
 *
 * Selection is explicit and there is no "fix everything" button, mirroring the
 * server: this rewrites identifiers that may already be printed on something.
 * Every reissue is recorded with its previous value, so a mistake is
 * recoverable rather than final.
 */

import * as React from 'react';
import { AlertTriangle, BadgeCheck, Printer, RefreshCw, Wrench } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { InventoryTabs } from '@/components/products/inventory-tabs';
import { CatalogueSettingsCard } from '@/components/products/catalogue-settings-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Toast, type ToastTone } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  fetchBarcodeAudit,
  printLabels,
  reissueBarcodes,
  type BarcodeAuditReport,
} from '@/lib/products/barcodes-api';

export default function BarcodesPage() {
  const { session, hasPermission } = useAuth();
  const canView = hasPermission(Permission.PRODUCT_READ);
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  const [report, setReport] = React.useState<BarcodeAuditReport | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<{ message: string; tone: ToastTone } | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const load = React.useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const next = await fetchBarcodeAudit(session);
      setReport(next);
      setSelected(new Set());
    } catch (err) {
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setLoading(false);
    }
  }, [session]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function toggle(variantId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }

  async function reissue() {
    if (!session || selected.size === 0) return;
    setBusy(true);
    try {
      const { reissued } = await reissueBarcodes(session, [...selected]);
      setToast({
        message: `Reissued ${reissued.length} barcode${reissued.length === 1 ? '' : 's'}. The previous values are in the audit log.`,
        tone: 'success',
      });
      await load();
    } catch (err) {
      // The server refuses a mixed selection wholesale and says why — a
      // supplier code, or something that is not an EAN-13 at all. That message
      // is more useful than anything this screen could invent.
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function printSelected() {
    if (!session || selected.size === 0) return;
    setBusy(true);
    try {
      const result = await printLabels(
        session,
        [...selected].map((variantId) => ({ variantId, quantity: 1 })),
        1,
      );
      setToast({
        message:
          result.skipped.length === 0
            ? `Queued ${result.labelCount} label${result.labelCount === 1 ? '' : 's'}.`
            : `Queued ${result.labelCount}. ${result.skipped.length} could not be drawn: ${result.skipped[0]!.reason}`,
        tone: result.skipped.length === 0 ? 'success' : 'warning',
      });
    } catch (err) {
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return <PageHeader title="Barcodes" description="You do not have access to the catalogue." />;
  }

  return (
    <div className="space-y-4">
      <InventoryTabs />
      <PageHeader
        title="Barcodes"
        description="Every barcode in this workspace, checked against the EAN-13 standard. A code with a wrong check digit cannot be printed as a label or read by a scanner."
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" /> Re-check
          </Button>
        }
      />

      {loading || !report ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Checking every barcode…
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Summary label="Variants" value={report.scanned} />
            <Summary label="With a barcode" value={report.withBarcode} />
            <Summary label="Valid EAN-13" value={report.valid} tone="success" />
            <Summary
              label="Wrong check digit"
              value={report.invalidCheckDigit}
              tone={report.invalidCheckDigit > 0 ? 'danger' : 'success'}
            />
          </div>

          {report.notEan13 > 0 ? (
            <p className="text-xs text-muted-foreground">
              {report.notEan13} barcode{report.notEan13 === 1 ? ' is' : 's are'} not 13-digit codes —
              supplier Code 128 labels and similar. Those are left exactly as printed.
            </p>
          ) : null}

          {report.problems.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-3 py-8">
                <BadgeCheck className="h-6 w-6 text-success" aria-hidden />
                <div>
                  <p className="text-sm font-medium">Every barcode checks out.</p>
                  <p className="text-sm text-muted-foreground">
                    All of them will render as EAN-13 labels and scan at the till.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <AlertTriangle className="h-4 w-4 text-danger" aria-hidden />
                    {report.problems.length} barcode
                    {report.problems.length === 1 ? '' : 's'} cannot be printed or scanned
                  </p>
                  {canManage ? (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void printSelected()}
                        disabled={selected.size === 0 || busy}
                      >
                        <Printer className="mr-2 h-4 w-4" /> Print labels
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void reissue()}
                        disabled={selected.size === 0 || busy}
                      >
                        <Wrench className="mr-2 h-4 w-4" />
                        Reissue {selected.size > 0 ? `(${selected.size})` : ''}
                      </Button>
                    </div>
                  ) : null}
                </div>

                <p className="text-xs text-muted-foreground">
                  Reissuing replaces the code with a correctly checksummed one. The previous value is
                  written to the audit log, and a supplier&apos;s barcode is never touched.
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="w-10 py-2" />
                        <th className="py-2">Product</th>
                        <th className="py-2">SKU</th>
                        <th className="py-2">Barcode</th>
                        <th className="py-2">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.problems.map((row) => (
                        <tr key={row.variantId} className="border-b last:border-0">
                          <td className="py-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.sku}`}
                              checked={selected.has(row.variantId)}
                              onChange={() => toggle(row.variantId)}
                              disabled={!canManage}
                            />
                          </td>
                          <td className="py-2">{row.productName}</td>
                          <td className="py-2 font-mono text-xs">{row.sku}</td>
                          <td className="py-2 font-mono text-xs">{row.barcode}</td>
                          <td className="py-2">
                            {row.source === 'SUPPLIER' ? (
                              <Badge variant="warning">Supplier</Badge>
                            ) : row.source === 'INTERNAL' ? (
                              <Badge variant="info">Ours</Badge>
                            ) : (
                              <Badge variant="neutral" title="Predates provenance tracking">
                                Unknown
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {session ? (
            <CatalogueSettingsCard
              session={session}
              canManage={canManage}
              onSaved={(message, ok) =>
                setToast({ message, tone: ok ? 'success' : 'danger' })
              }
            />
          ) : null}
        </>
      )}

      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'danger';
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={
            tone === 'danger'
              ? 'text-2xl font-semibold text-danger'
              : tone === 'success'
                ? 'text-2xl font-semibold text-success'
                : 'text-2xl font-semibold'
          }
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
