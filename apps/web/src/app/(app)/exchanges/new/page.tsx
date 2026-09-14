'use client';

/**
 * D128 / D128a / D173 — swap what did not fit.
 *
 * ## What this screen is
 *
 * A customer brings back one or more lines from a completed sale and takes a
 * different variant of each in its place. The returning leg refunds what came
 * back; the replacement leg is sold in full.
 *
 * `7.5` shipped the thinnest visible path — ONE returned line, one replacement
 * — and said so: "multi-line exchanges … out of scope by agreement". D173
 * closed that, because the agreement did not survive contact with a shop. A
 * customer who bought three things and wants two swapped had to be served as
 * two separate exchanges, which produces two exchange numbers, two returns and
 * two replacement sales for one visit to the counter — and the second one can
 * trip approval on its own.
 *
 * **Nothing on the server changed.** `returnItems` and `replacementItems` were
 * always arrays with no upper bound, and the exchange service builds a Return
 * and a Sale, both of which have always held many lines. The single-item
 * assumption lived entirely in this file.
 *
 * ## What this screen has to say out loud
 *
 * **Settlement is gross** (D128a). The customer is handed the value of what
 * they brought back and pays for what they take away. For an even swap those
 * are the same figure and nothing changes hands — but the till records both, so
 * the screen shows both rather than only the difference.
 *
 * **A manager PIN is asked for only when one is genuinely required.** D130
 * waived the full-sale-return trigger for exchanges, on the server, in
 * `evaluateApproval`. This screen previews through `POST /exchanges/preview` so
 * the same rule decides both. Every other trigger still applies — a cashier
 * over their refund limit, a sale outside the return period, damaged goods, a
 * credit customer, a mismatched refund method.
 *
 * D173 makes that more than a detail: approval is evaluated on the WHOLE
 * basket, once, the way the completion will evaluate it. Two separate exchanges
 * could each pass a per-exchange refund limit that the combined basket exceeds.
 *
 * ## Still not supported, deliberately
 *
 * The replacement must be another **variant of the same product** — a Medium
 * for a Large, not a shirt for a tie. The server permits it (`replacementItems`
 * takes any `productId`), so this is a UI limit, not a rule: swapping to a
 * different product needs a product search in the replacement step and its own
 * answers about what the refund is measured against.
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
import {
  clampQuantity,
  everyLineAnswered,
  replacementFor,
  replacementTotal,
  selectedLines,
  selectionKey,
  toReplacementItems,
  toReturnItems,
  type LineChoice,
} from '@/lib/exchange-basket';

export default function NewExchangePage() {
  const { session, hasPermission } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const saleId = params?.get('saleId') ?? '';

  const canExchange =
    hasPermission(Permission.RETURN_CREATE) && hasPermission(Permission.SALE_CREATE);

  const [items, setItems] = React.useState<ReturnableItem[]>([]);
  const [choices, setChoices] = React.useState<Record<string, LineChoice>>({});
  /** Sibling variants, per product id. Several lines may share a product. */
  const [variantsByProduct, setVariantsByProduct] = React.useState<
    Record<string, ProductVariant[]>
  >({});
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
        // A single-line sale has only one answer to "what is coming back", so
        // give it. More than one and the operator must say.
        if (rows.length === 1) {
          const only = rows[0]!;
          setChoices({
            [only.saleItemId]: {
              quantity: only.availableReturnQuantity,
              replacementVariantId: '',
            },
          });
        }
      })
      .catch((err: Error) => !cancelled && setToast({ message: err.message, tone: 'danger' }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, saleId]);

  /** The lines actually coming back. `exchange-basket.ts` owns the rule. */
  const selected = React.useMemo(() => selectedLines(items, choices), [items, choices]);

  // ── sibling variants for every selected product ───────────────────────────
  //
  // Keyed on the distinct product ids rather than on `selected`, so changing a
  // quantity does not refetch a list that cannot have changed.
  const productIds = React.useMemo(
    () => Array.from(new Set(selected.map((s) => s.line.productId))).sort().join(','),
    [selected],
  );

  React.useEffect(() => {
    if (!session || !productIds) return;
    let cancelled = false;
    const ids = productIds.split(',');
    Promise.all(
      ids.map(async (id) => [id, await fetchVariants(session, id).catch(() => [])] as const),
    )
      .then((pairs) => {
        if (cancelled) return;
        setVariantsByProduct((prev) => {
          const next = { ...prev };
          for (const [id, rows] of pairs) next[id] = rows.filter((v) => v.isActive);
          return next;
        });
      })
      // A product with no variants simply offers no replacement — the line says
      // so rather than showing an empty dropdown with no explanation.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, productIds]);

  // ── preview the whole returning basket, for its value AND its verdict ─────
  //
  // `previewExchange`, NOT `previewReturn`: the returns route cannot know it is
  // inside an exchange and would evaluate approval without D130's waiver.
  //
  // Every selected line is sent, so the refund total and the approval verdict
  // are the ones the completion will produce. Previewing line by line and
  // adding up would miss a limit that only the combined basket crosses.
  const previewKey = React.useMemo(() => selectionKey(selected), [selected]);

  React.useEffect(() => {
    if (!session || selected.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    previewExchange(session, {
      originalSaleId: saleId,
      items: toReturnItems(selected),
      refundMethod: 'CASH',
    })
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setToast({ message: err.message, tone: 'danger' }));
    return () => {
      cancelled = true;
    };
    // `previewKey` is the selection's identity; `selected` is a new array every
    // render and would re-request on every keystroke elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, saleId, previewKey]);

  const returnedValue = preview?.refundTotal ?? 0;

  const replacementValue = React.useMemo(
    () => replacementTotal(selected, variantsByProduct),
    [selected, variantsByProduct],
  );

  const answered = React.useMemo(
    () => everyLineAnswered(selected, variantsByProduct),
    [selected, variantsByProduct],
  );
  const netDifference = answered ? replacementValue - returnedValue : null;
  const needsApproval = preview?.requiresApproval === true;

  const canSubmit = canExchange && answered && (!needsApproval || managerPin !== '');

  function setChoice(saleItemId: string, patch: Partial<LineChoice>): void {
    setChoices((prev) => ({
      ...prev,
      [saleItemId]: {
        quantity: 0,
        replacementVariantId: '',
        ...prev[saleItemId],
        ...patch,
      },
    }));
  }

  async function submit() {
    if (!session || !preview || !answered) return;
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
        returnItems: toReturnItems(selected),
        replacementItems: toReplacementItems(selected, variantsByProduct),
        // Gross settlement (D128a): the replacement basket is paid for in full.
        payments: [{ method: 'CASH', amount: replacementValue }],
        refundMethod: 'CASH',
        approvalToken,
      });
      setResult(exchange);
      setToast({ message: `Exchange ${exchange.exchangeNumber} completed.`, tone: 'success' });
    } catch (err) {
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (!canExchange) {
    return (
      <div className="space-y-4">
        <PageHeader title="Exchange" />
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You do not have permission to take an exchange.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (result) {
    return (
      <div className="space-y-4">
        <PageHeader title="Exchange" />
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <Check className="mx-auto h-10 w-10 text-success" aria-hidden />
            <p className="text-lg font-semibold">Exchange {result.exchangeNumber} completed</p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={() => router.push(`/sales/${saleId}`)}>
                Back to the sale
              </Button>
              <Button onClick={() => router.push('/pos')}>New sale</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        href={`/sales/${saleId}`}
        className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to the sale
      </Link>
      <PageHeader
        title="Exchange"
        description="Take items back and give others in their place. The customer is refunded what they return and pays for what they take."
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
              <p className="text-xs text-muted-foreground">
                Tick every line the customer is bringing back. A line bought more than once can
                come back in part.
              </p>
              {items.map((item) => {
                const choice = choices[item.saleItemId];
                const taken = choice?.quantity ?? 0;
                const max = item.availableReturnQuantity;
                return (
                  <div
                    key={item.saleItemId}
                    className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
                  >
                    <input
                      id={`line-${item.saleItemId}`}
                      type="checkbox"
                      aria-label={`Bring back ${item.productName}`}
                      checked={taken > 0}
                      // Ticking takes the whole line, which is the common case;
                      // the quantity box below is for the rest.
                      onChange={(e) => setChoice(item.saleItemId, { quantity: e.target.checked ? max : 0 })}
                    />
                    <label htmlFor={`line-${item.saleItemId}`} className="flex-1 cursor-pointer">
                      {item.productName}
                      {item.sku ? (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {item.sku}
                        </span>
                      ) : null}
                    </label>
                    {max > 1 ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Input
                          type="number"
                          min={0}
                          max={max}
                          aria-label={`Quantity of ${item.productName} coming back`}
                          className="h-8 w-16"
                          value={taken}
                          onChange={(e) =>
                            setChoice(item.saleItemId, {
                              quantity: clampQuantity(Number(e.target.value), max),
                            })
                          }
                        />
                        of {max}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">×{max}</span>
                    )}
                    <span className="font-medium">{formatCurrency(item.lineTotal)}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-4">
              <Label>2 · What is going out instead</Label>
              {selected.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tick what is coming back first.
                </p>
              ) : (
                selected.map((row) => {
                  const list = variantsByProduct[row.line.productId] ?? [];
                  return (
                    <div
                      key={row.line.saleItemId}
                      className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
                    >
                      <span className="min-w-[10rem] flex-1">
                        {row.line.productName}
                        {row.quantity > 1 ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ×{row.quantity}
                          </span>
                        ) : null}
                      </span>
                      {list.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          No other variant to swap to.
                        </span>
                      ) : (
                        <Select
                          aria-label={`Replacement for ${row.line.productName}`}
                          className="w-full sm:w-auto sm:min-w-[16rem]"
                          value={row.replacementVariantId}
                          onChange={(e) =>
                            setChoice(row.line.saleItemId, {
                              replacementVariantId: e.target.value,
                            })
                          }
                        >
                          <option value="">Choose a replacement…</option>
                          {list.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.optionValues.map((o) => o.optionName).join(' / ') || v.sku} —{' '}
                              {formatCurrency(v.unitPrice)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  );
                })
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

              {selected.length > 0 && !answered ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Choose a replacement for every
                  line to see the difference.
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
