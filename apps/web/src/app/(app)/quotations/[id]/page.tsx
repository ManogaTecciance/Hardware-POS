'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Copy, FileDown, Mail, MessageCircle, Pencil, Send, XCircle } from 'lucide-react';
import { QUOTATION_STATUS_LABELS, type QuotationStatusCode } from '@hardware-pos/shared';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  cancelQuotation,
  convertQuotationToSale,
  duplicateQuotation,
  fetchQuotation,
  fetchQuotationDocument,
  fetchRevisions,
  markQuotationSent,
  openPrintWindow,
  shareQuotationEmail,
  shareQuotationWhatsapp,
  type QuotationDetail,
  type QuotationRevisionSummary,
} from '@/lib/quotations';
import { saleLocation } from '@/lib/sales';
import { formatMoney } from '@/lib/utils';

const STATUS_BADGE: Record<QuotationStatusCode, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  SENT: 'primary',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
  REVISED: 'primary',
  CONVERTED_TO_SALE: 'success',
  CANCELLED: 'neutral',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function QuotationDetailPage() {
  const { session, hasPermission } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [q, setQ] = React.useState<QuotationDetail | null>(null);
  const [revisions, setRevisions] = React.useState<QuotationRevisionSummary[]>([]);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [convertOpen, setConvertOpen] = React.useState(false);
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [emailTo, setEmailTo] = React.useState('');
  const [emailMessage, setEmailMessage] = React.useState('');

  const load = React.useCallback(() => {
    if (!session) return;
    void fetchQuotation(session, params.id).then((detail) => {
      setQ(detail);
      setEmailTo(detail.customer?.email ?? '');
    });
    void fetchRevisions(session, params.id).then(setRevisions);
  }, [session, params.id]);

  React.useEffect(() => load(), [load]);

  if (!session) return null;
  if (!q) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const isTerminal = q.status === 'CONVERTED_TO_SALE' || q.status === 'CANCELLED';
  const canEdit = hasPermission(Permission.QUOTATION_CREATE) && !isTerminal;
  const canConvert = hasPermission(Permission.QUOTATION_CONVERT) && q.status !== 'CANCELLED' && !q.convertedSaleId;
  const canCancel = hasPermission(Permission.QUOTATION_CANCEL) && !isTerminal;
  const canShare = hasPermission(Permission.QUOTATION_SHARE);

  async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setFlash(null);
    try {
      return await fn();
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Action failed');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function printDoc() {
    await withBusy(async () => {
      const { html } = await fetchQuotationDocument(session!, q!.id);
      openPrintWindow(html);
    });
  }

  async function whatsapp() {
    const res = await withBusy(() => shareQuotationWhatsapp(session!, q!.id));
    if (res?.whatsappUrl) window.open(res.whatsappUrl, '_blank');
  }

  async function sendEmail() {
    const res = await withBusy(() =>
      shareQuotationEmail(session!, q!.id, { to: emailTo || undefined, message: emailMessage || undefined }),
    );
    if (res) {
      setFlash(res.status === 'SENT' ? `Email sent to ${res.recipient}` : `Email failed: ${res.error ?? ''}`);
      setEmailOpen(false);
    }
  }

  async function convert(withPayment: boolean) {
    const res = await withBusy(() =>
      convertQuotationToSale(session!, q!.id, {
        ...saleLocation(session!),
        payments: withPayment ? [{ method: 'CASH', amount: q!.grandTotal }] : [],
      }),
    );
    if (res) router.push(`/sales/${res.saleId}`);
  }

  async function duplicate() {
    const res = await withBusy(() => duplicateQuotation(session!, q!.id));
    if (res) router.push(`/quotations/${res.id}`);
  }

  async function markSent() {
    await withBusy(() => markQuotationSent(session!, q!.id));
    load();
  }

  async function cancel() {
    await withBusy(() => cancelQuotation(session!, q!.id));
    load();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={q.revisionLabel}
        description={`Issued ${fmtDate(q.issueDate)}${q.createdByName ? ` by ${q.createdByName}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_BADGE[q.status]}>{QUOTATION_STATUS_LABELS[q.status]}</Badge>
            {q.isExpired && <Badge variant="warning">Expired</Badge>}
          </div>
        }
      />

      {flash && (
        <div className="rounded-xl border border-border bg-muted/50 px-4 py-2 text-sm">{flash}</div>
      )}

      {q.convertedSaleNumber && (
        <div className="rounded-xl border border-success-soft bg-success-soft/40 px-4 py-2 text-sm">
          Converted to sale{' '}
          <Link href={`/sales/${q.convertedSaleId}`} className="font-medium text-primary hover:underline">
            {q.convertedSaleNumber}
          </Link>
          .
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/quotations/${q.id}/edit`}>
              <Pencil className="h-4 w-4" /> {q.status === 'DRAFT' ? 'Edit' : 'Create revision'}
            </Link>
          </Button>
        )}
        {q.status === 'DRAFT' && canEdit && (
          <Button variant="outline" size="sm" disabled={busy} onClick={markSent}>
            <Send className="h-4 w-4" /> Mark sent
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={printDoc}>
          <FileDown className="h-4 w-4" /> Print / PDF
        </Button>
        {canShare && (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={whatsapp}>
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEmailOpen(true)}>
              <Mail className="h-4 w-4" /> Email
            </Button>
          </>
        )}
        {canConvert && (
          <Button size="sm" disabled={busy} onClick={() => setConvertOpen(true)}>
            Convert to sale
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={duplicate}>
          <Copy className="h-4 w-4" /> Duplicate
        </Button>
        {canCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            disabled={busy}
            onClick={cancel}
          >
            <XCircle className="h-4 w-4" /> Cancel quotation
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Product</th>
                    <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-4 py-2.5 text-right font-medium">Unit price</th>
                    <th className="px-4 py-2.5 text-right font-medium">Discount</th>
                    <th className="px-4 py-2.5 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {q.items.map((it) => (
                    <tr key={it.id}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{it.productName}</div>
                        {it.sku && <div className="text-xs text-muted-foreground">{it.sku}</div>}
                        {it.itemNote && <div className="text-xs text-muted-foreground">Note: {it.itemNote}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {it.quantity}
                        {it.unitType ? ` ${it.unitType}` : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right">{formatMoney(it.unitPrice)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {/* A per-unit discount shows its arithmetic: the amount
                            taken is larger than the figure quoted per item, and
                            the customer should be able to check it. */}
                        {it.discountAmount > 0
                          ? `- ${formatMoney(it.discountAmount)}${
                              it.discountBasis === 'UNIT' && it.discountValue != null
                                ? ` (${formatMoney(it.discountValue)} × ${it.quantity})`
                                : ''
                            }`
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium">{formatMoney(it.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CardContent className="flex justify-end p-4">
              <div className="w-full max-w-xs space-y-1 text-sm">
                <Totals label="Subtotal" value={formatMoney(q.subtotal)} />
                {q.productDiscountTotal > 0 && (
                  <Totals label="Product discounts" value={`- ${formatMoney(q.productDiscountTotal)}`} muted />
                )}
                {q.quotationDiscountAmount > 0 && (
                  <Totals label="Quotation discount" value={`- ${formatMoney(q.quotationDiscountAmount)}`} muted />
                )}
                {q.taxAmount > 0 && <Totals label="Tax / VAT" value={formatMoney(q.taxAmount)} />}
                <div className="flex items-center justify-between border-t border-border pt-1.5 text-base font-semibold">
                  <span>Grand total</span>
                  <span className="text-primary">{formatMoney(q.grandTotal)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {(q.notes || q.termsAndConditions) && (
            <Card>
              <CardContent className="space-y-3 p-4 text-sm">
                {q.notes && (
                  <div>
                    <div className="text-xs font-medium uppercase text-muted-foreground">Notes</div>
                    <p className="mt-1 whitespace-pre-wrap">{q.notes}</p>
                  </div>
                )}
                {q.termsAndConditions && (
                  <div>
                    <div className="text-xs font-medium uppercase text-muted-foreground">Terms &amp; conditions</div>
                    <p className="mt-1 whitespace-pre-wrap">{q.termsAndConditions}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 p-4 pt-0 text-sm">
              {q.customer ? (
                <>
                  <div className="font-medium">{q.customer.name}</div>
                  {q.customer.companyName && <div className="text-muted-foreground">{q.customer.companyName}</div>}
                  {q.customer.phone && <div className="text-muted-foreground">{q.customer.phone}</div>}
                  {q.customer.email && <div className="text-muted-foreground">{q.customer.email}</div>}
                  {q.customer.billingAddress && (
                    <div className="text-muted-foreground">{q.customer.billingAddress}</div>
                  )}
                </>
              ) : (
                <div className="text-muted-foreground">Walk-in customer</div>
              )}
              <div className="border-t border-border pt-2 text-muted-foreground">
                Valid until <span className={q.isExpired ? 'text-danger' : ''}>{fmtDate(q.validUntil)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Revision history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              {revisions.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                  <div>
                    <div className="font-medium">
                      {r.revisionNumber === 0 ? 'Original' : `Revision R${r.revisionNumber}`}
                    </div>
                    {r.changeReason && <div className="text-xs text-muted-foreground">{r.changeReason}</div>}
                    <div className="text-xs text-muted-foreground">
                      {r.changedByName ?? '—'} · {fmtDate(r.createdAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{formatMoney(r.grandTotal)}</div>
                    {r.previousGrandTotal != null && (
                      <div className="text-xs text-muted-foreground line-through">
                        {formatMoney(r.previousGrandTotal)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {revisions.length === 0 && <p className="text-muted-foreground">No revisions.</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Convert dialog */}
      <Dialog
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        className="sm:max-w-xl"
        title="Convert to sale"
        description="Create a sale from this quotation. The sale is linked back to the quotation."
        footer={
          <>
            <Button variant="outline" onClick={() => setConvertOpen(false)}>
              Cancel
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => convert(false)}>
              Create invoice (unpaid)
            </Button>
            <Button disabled={busy} onClick={() => convert(true)}>
              Take cash payment ({formatMoney(q.grandTotal)})
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          “Create invoice” records an unpaid sale (a customer is required). “Take cash payment” marks
          it paid in full. You can also open the created sale to take payment via the POS.
        </p>
      </Dialog>

      {/* Email dialog */}
      <Dialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        title="Email quotation"
        description="Sends the A4 quotation as an attachment."
        footer={
          <>
            <Button variant="outline" onClick={() => setEmailOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !emailTo} onClick={sendEmail}>
              Send email
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            To
            <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="customer@example.com" className="mt-1" />
          </label>
          <label className="block text-sm">
            Message (optional)
            <Textarea value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} className="mt-1" />
          </label>
        </div>
      </Dialog>
    </div>
  );
}

function Totals({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={muted ? 'text-muted-foreground' : ''}>{value}</span>
    </div>
  );
}
