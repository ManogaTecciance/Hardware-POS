'use client';

/**
 * D128 / D128a — swap a Medium for a Large (Phase 7, `7.5`).
 *
 * The thinnest visible path, deliberately: one returned line, one replacement
 * variant **of the same product**, settled and done. Multi-line exchanges,
 * cross-branch, and exchanging against a different sale are all out of scope by
 * agreement — none is load-bearing for the phase gate, and each would need its
 * own answers about stock, approval and documents.
 *
 * ## What this screen has to say out loud
 *
 * **Settlement is gross** (D128a). The customer is handed the value of what they
 * brought back and pays for what they take away. For an even swap those are the
 * same figure and nothing changes hands — but the till still records both, so
 * the screen shows both rather than only the difference.
 *
 * **A manager PIN is asked for only when one is genuinely required.** This
 * paragraph used to say it was "usually" required, because `Full-sale return`
 * is an approval trigger and a customer swapping the size of the one shirt
 * they bought returns the whole sale by definition. **D130 waived exactly that
 * trigger for exchanges** — on the server, in `evaluateApproval` — and this
 * screen was never updated, so it went on previewing through the plain returns
 * route and demanding a PIN the completion did not want. An owner was being
 * asked to approve themselves.
 *
 * It now previews through `POST /exchanges/preview`, which evaluates approval
 * the way the completion will. **Every other trigger still applies** — a
 * cashier over their refund limit, a sale outside the return period, damaged
 * goods, a credit customer, a mismatched refund method. Those are about the
 * goods and the money, and an exchange changes neither.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toast, type ToastTone } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { formatCurrency } from '@hardware-pos/shared';
import {
  approveReturn,
  fetchReturnableItems,
  type ReturnableItem,
  type ReturnPreview,
} from '@/lib/returns';
import { fetchVariants, type ProductVariant } from '@/lib/products/variants-api';
import { completeExchange, previewExchange, type ExchangeResult } from '@/lib/exchanges';

/** A size swap is "not suitable": the shop sent what was ordered and it did not fit. */
const EXCHANGE_REASON = 'NOT_SUITABLE' as const;

export default function NewExchangePage() {
  const { session, hasPermission } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const saleId = params?.get('saleId') ?? '';

  const canExchange =
    hasPermission(Permission.RETURN_CREATE) && hasPermission(Permission.SALE_CREATE);

  const [items, setItems] = React.useState<ReturnableItem[]>([]);
  const [chosenSaleItemId, setChosenSaleItemId] = React.useState('');
  const [variants, setVariants] = React.useState<ProductVariant[]>([]);
  const [replacementVariantId, setReplacementVariantId] = React.useState('');
  const [preview, setPreview] = React.useState<ReturnPreview | null>(null);
  const [managerPin, setManagerPin] = React.useState('');
  const [result, setResult] = React.useState<ExchangeResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<{ message: string; tone: ToastTone } | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ── the returnable lines ───────────────────────────────────────────────────
  React.useEffect(() => {
    if (!session || !saleId) return;
    let cancelled = false;
    setLoading(true);
    fetchReturnableItems(session, saleId)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        if (rows.length === 1) setChosenSaleItemId(rows[0]!.saleItemId);
      })
      .catch((err: Error) => !cancelled && setToast({ message: err.message, tone: 'danger' }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, saleId]);

  const chosen = items.find((i) => i.saleItemId === chosenSaleItemId) ?? null;

  // ── the sibling variants of that product ──────────────────────────────────
  React.useEffect(() => {
    if (!session || !chosen) {
      setVariants([]);
      return;
    }
    let cancelled = false;
    fetchVariants(session, chosen.productId)
      .then((rows) => !cancelled && setVariants(rows.filter((v) => v.isActive)))
      // A product with no variants simply offers no replacement — the screen
      // says so rather than showing an empty dropdown with no explanation.
      .catch(() => !cancelled && setVariants([]));
    return () => {
      cancelled = true;
    };
  }, [session, chosen]);

  // ── preview the returning leg, for its value AND its approval verdict ─────
  //
  // `previewExchange`, NOT `previewReturn`. The returns route cannot know it
  // is inside an exchange, so it evaluated approval without D130's waiver and
  // this screen demanded a manager PIN on every exchange — including from an
  // owner, who was being asked to approve themselves. The completion never
  // wanted it. Same rule, both paths, decided on the server.
  React.useEffect(() => {
    if (!session || !chosen) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    previewExchange(session, {
      originalSaleId: saleId,
      items: [
        {
          saleItemId: chosen.saleItemId,
          returnQuantity: chosen.availableReturnQuantity,
          returnReason: EXCHANGE_REASON,
          itemCondition: 'GOOD',
          stockDisposition: 'RETURN_TO_STOCK',
        },
      ],
      refundMethod: 'CASH',
    })
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setToast({ message: err.message, tone: 'danger' }));
    return () => {
      cancelled = true;
    };
  }, [session, chosen, saleId]);

  const replacement = variants.find((v) => v.id === replacementVariantId) ?? null;
  const returnedValue = preview?.refundTotal ?? 0;
  const replacementValue = replacement?.unitPrice ?? 0;
  const netDifference = replacement ? replacementValue - returnedValue : null;
  const needsApproval = preview?.requiresApproval === true;

  const canSubmit =
    canExchange && chosen !== null && replacement !== null && (!needsApproval || managerPin !== '');

  async function submit() {
    if (!session || !chosen || !replacement || !preview) return;
    setBusy(true);
    try {
      let approvalToken: string | undefined;
      if (needsApproval) {
        const approval = await approveReturn(session, {
          managerPin,
          originalSaleId: saleId,
          refundTotal: preview.refundTotal,
        });
        if (!approval.approved || !approval.approvalToken) {
          setToast({ message: approval.reason ?? 'Approval was refused.', tone: 'danger' });
          setBusy(false);
          return;
        }
        approvalToken = approval.approvalToken;
      }

      const exchange = await completeExchange(session, {
        originalSaleId: saleId,
        branchId: session.branchId ?? '',
        registerId: session.registerId ?? undefined,
        returnItems: [
          {
            saleItemId: chosen.saleItemId,
            returnQuantity: chosen.availableReturnQuantity,
            returnReason: EXCHANGE_REASON,
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
        replacementItems: [
          {
            productId: chosen.productId,
            productVariantId: replacement.id,
            quantity: chosen.availableReturnQuantity,
          },
        ],
        // Gross settlement (D128a): the replacement is paid for in full.
        payments: [
          { method: 'CASH', amount: replacementValue * chosen.availableReturnQuantity },
        ],
        refundMethod: 'CASH',
        approvalToken,
      });
      setResult(exchange);
      setToast({ message: `Exchange ${exchange.exchangeNumber} completed.`, tone: 'success' });
    } catch (err) {
      // The server's message is more useful than anything this screen could
      // invent — it knows which rule refused and why.
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (!canExchange) {
    return (
      <PageHeader
        title="Exchange"
        description="You need permission to take returns and to make sales."
      />
    );
  }

  if (!saleId) {
    return (
      <PageHeader
        title="Exchange"
        description="Start an exchange from a completed sale."
        actions={
          <Link href="/sales">
            <Button variant="outline">Go to sales</Button>
          </Link>
        }
      />
    );
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="space-y-4">
        <PageHeader title={`Exchange ${result.exchangeNumber}`} description="Completed." />
        <Card>
          <CardContent className="space-y-3 py-5">
            <div className="flex items-center gap-2 text-success">
              <Check className="h-5 w-5" aria-hidden />
              <span className="font-medium">
                {result.complete ? 'Both legs completed.' : 'The replacement did not complete.'}
              </span>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <Money label="Refunded to customer" value={result.returnedValue} />
              <Money label="Charged for replacement" value={result.replacementValue ?? 0} />
              <Money
                label={
                  (result.netDifference ?? 0) >= 0 ? 'Customer paid extra' : 'Customer got back'
                }
                value={Math.abs(result.netDifference ?? 0)}
                strong
              />
            </dl>
            <p className="text-xs text-muted-foreground">
              Return {result.returnNumber}
              {result.replacementSaleNumber ? ` · Sale ${result.replacementSaleNumber}` : ''}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => router.push(`/sales/${saleId}`)}>Back to the sale</Button>
              <Button variant="outline" onClick={() => router.push('/sales')}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
        {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        href={`/sales/${saleId}`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to the sale
      </Link>

      <PageHeader
        title="Exchange"
        description="Take one item back and give another in its place. The customer is refunded what they return and pays for what they take."
      />

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing on this sale can be exchanged.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-3 py-4">
              <Label>1 · What is coming back</Label>
              {items.map((item) => (
                <label
                  key={item.saleItemId}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="returned-line"
                    checked={chosenSaleItemId === item.saleItemId}
                    onChange={() => {
                      setChosenSaleItemId(item.saleItemId);
                      setReplacementVariantId('');
                    }}
                  />
                  <span className="flex-1">
                    {item.productName}
                    {item.sku ? (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {item.sku}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">
                    ×{item.availableReturnQuantity}
                  </span>
                  <span className="font-medium">{formatCurrency(item.lineTotal)}</span>
                </label>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-4">
              <Label htmlFor="replacement">2 · What is going out instead</Label>
              {!chosen ? (
                <p className="text-sm text-muted-foreground">Choose the returned item first.</p>
              ) : variants.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This product has no other variants to swap to. Exchanging for a different
                  product is not supported yet.
                </p>
              ) : (
                <Select
                  id="replacement"
                  value={replacementVariantId}
                  onChange={(e) => setReplacementVariantId(e.target.value)}
                >
                  <option value="">Choose a replacement…</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.optionValues.map((o) => o.optionName).join(' / ') || v.sku} —{' '}
                      {formatCurrency(v.unitPrice)}
                    </option>
                  ))}
                </Select>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-4">
              <Label>3 · The money</Label>
              <dl className="grid gap-2 text-sm sm:grid-cols-3">
                <Money label="Refund to customer" value={returnedValue} />
                <Money label="Charge for replacement" value={replacementValue} />
                <Money
                  label={
                    netDifference === null
                      ? 'Difference'
                      : netDifference >= 0
                        ? 'Customer pays'
                        : 'Customer receives'
                  }
                  value={Math.abs(netDifference ?? 0)}
                  strong
                />
              </dl>
              <p className="text-xs text-muted-foreground">
                Both amounts are recorded. For an even swap nothing changes hands and the drawer
                nets to zero.
              </p>

              {needsApproval ? (
                <div className="space-y-2 rounded-md border border-warning bg-warning-soft p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-warning">
                    <ShieldCheck className="h-4 w-4" aria-hidden /> A manager must approve this
                  </p>
                  <ul className="list-inside list-disc text-xs text-warning">
                    {preview?.approvalReasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                  <Input
                    type="password"
                    inputMode="numeric"
                    placeholder="Manager PIN"
                    className="max-w-[12rem]"
                    value={managerPin}
                    onChange={(e) => setManagerPin(e.target.value)}
                  />
                </div>
              ) : null}

              {chosen && !replacement ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Choose a replacement to see the
                  difference.
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button onClick={() => void submit()} disabled={!canSubmit || busy}>
                  {busy ? 'Working…' : 'Complete exchange'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}

function Money({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={strong ? 'text-lg font-semibold' : 'text-base'}>{formatCurrency(value)}</dd>
    </div>
  );
}
