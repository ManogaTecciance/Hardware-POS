'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, Minus, Plus, Search, ShieldCheck } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { useReturnDraft } from '@/lib/return-draft';
import {
  approveReturn,
  createReturn,
  fetchReturnableItems,
  fetchReturnEligibility,
  previewReturn,
  type ReturnableItem,
  type ReturnEligibility,
  type ReturnItemInput,
  type ReturnPreview,
} from '@/lib/returns';
import { fetchSales, type PaymentMethodCode, type SaleListItem } from '@/lib/sales';
import { cn, formatMoney } from '@/lib/utils';
import {
  DEFAULT_DISPOSITION_FOR_CONDITION,
  ITEM_CONDITION_OPTIONS,
  RETURN_REASON_OPTIONS,
  STOCK_DISPOSITION_OPTIONS,
  type ItemConditionCode,
  type ReturnReasonCode,
  type StockDispositionCode,
} from '@hardware-pos/shared';

type Step = 'find' | 'select' | 'details' | 'review' | 'refund';
const STEP_LABELS: Record<Step, string> = {
  find: 'Find sale',
  select: 'Select items',
  details: 'Reasons & condition',
  review: 'Review refund',
  refund: 'Refund & complete',
};

const REFUND_METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  STORE_CREDIT: 'Store credit',
  QR_PAYMENT: 'QR payment',
  CHECK: 'Cheque',
  OTHER: 'Other',
};

function buildItems(selections: ReturnType<typeof useReturnDraft>['selections']): ReturnItemInput[] {
  return Object.entries(selections).map(([saleItemId, sel]) => ({
    saleItemId,
    returnQuantity: sel.returnQuantity,
    returnReason: (sel.returnReason ?? 'WRONG_PRODUCT') as ReturnReasonCode,
    itemCondition: (sel.itemCondition ?? 'GOOD') as ItemConditionCode,
    stockDisposition: (sel.stockDisposition ?? 'RETURN_TO_STOCK') as StockDispositionCode,
    note: sel.note,
  }));
}

export default function NewReturnPage() {
  const router = useRouter();
  const params = useSearchParams();
  const saleId = params.get('saleId') ?? '';
  const { session } = useAuth();
  const draft = useReturnDraft();

  const [step, setStep] = React.useState<Step>(saleId ? 'select' : 'find');
  const [elig, setElig] = React.useState<ReturnEligibility | null>(null);
  const [items, setItems] = React.useState<ReturnableItem[]>([]);
  const [preview, setPreview] = React.useState<ReturnPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [pinOpen, setPinOpen] = React.useState(false);
  const idemKey = React.useRef<string>('');

  // Load the sale (eligibility + returnable lines) whenever a saleId is present.
  React.useEffect(() => {
    if (!session || !saleId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchReturnEligibility(session, saleId), fetchReturnableItems(session, saleId)])
      .then(([e, its]) => {
        if (cancelled) return;
        setElig(e);
        setItems(its);
        draft.startDraft(saleId, e.saleNumber);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to load sale'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, saleId]);

  const selectedIds = Object.keys(draft.selections);
  const hasSelection = selectedIds.length > 0;

  // Debounced server preview drives the always-visible refund summary. The server
  // is the source of truth — client math is never used for the refund amount.
  const signature = JSON.stringify({ s: draft.selections, m: draft.refundMethod });
  React.useEffect(() => {
    if (!session || !saleId || !hasSelection) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      previewReturn(session, {
        originalSaleId: saleId,
        items: buildItems(draft.selections),
        refundMethod: draft.refundMethod,
      })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          // A changed refund total invalidates any prior manager approval.
          if (draft.approvalToken && p.requiresApproval && p.refundTotal !== approvedForTotal.current) {
            draft.setApprovalToken(undefined);
          }
        })
        .catch(() => !cancelled && setPreview(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, saleId, signature]);

  const approvedForTotal = React.useRef<number>(-1);

  const needsApproval = !!preview?.requiresApproval && !draft.approvalToken;

  // ── handlers ──────────────────────────────────────────────────────────────

  const toggleItem = (it: ReturnableItem) => {
    if (draft.selections[it.saleItemId]) {
      draft.removeSelection(it.saleItemId);
    } else {
      draft.setSelection(it.saleItemId, {
        returnQuantity: Math.min(1, it.availableReturnQuantity) || 1,
        returnReason: 'WRONG_PRODUCT',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      });
    }
  };

  const changeQty = (it: ReturnableItem, delta: number) => {
    const cur = draft.selections[it.saleItemId]?.returnQuantity ?? 0;
    const next = Math.max(1, Math.min(it.availableReturnQuantity, cur + delta));
    draft.setSelection(it.saleItemId, { returnQuantity: next });
  };

  const setCondition = (saleItemId: string, condition: ItemConditionCode) => {
    draft.setSelection(saleItemId, {
      itemCondition: condition,
      // Keep disposition consistent with condition (damaged items can't restock).
      stockDisposition: DEFAULT_DISPOSITION_FOR_CONDITION[condition],
    });
  };

  const submit = async () => {
    if (!session || !preview) return;
    if (!draft.refundMethod) {
      setError('Choose a refund method');
      return;
    }
    if (!idemKey.current) idemKey.current = cryptoKey();
    setSubmitting(true);
    setError(null);
    try {
      const created = await createReturn(session, {
        originalSaleId: saleId,
        items: buildItems(draft.selections),
        refundMethod: draft.refundMethod,
        refundReference: draft.refundReference || undefined,
        approvalToken: draft.approvalToken || undefined,
        notes: draft.notes || undefined,
        idempotencyKey: idemKey.current,
      });
      draft.clearDraft();
      router.push(`/returns/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the return');
      setSubmitting(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  const stepsShown: Step[] = saleId
    ? ['select', 'details', 'review', 'refund']
    : ['find', 'select', 'details', 'review', 'refund'];

  return (
    <div className="space-y-6">
      <PageHeader
        title="New return"
        description={elig ? `Against sale ${elig.saleNumber}` : 'Find the original sale to return against.'}
        actions={
          <Link href="/returns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Returns
          </Link>
        }
      />

      <StepIndicator steps={stepsShown} current={step} />

      {error ? (
        <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">{error}</div>
      ) : null}

      {elig && !elig.eligible ? (
        <div className="rounded-xl bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
          This sale cannot be returned: {elig.reasons.join('; ')}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Main step content */}
        <div className="space-y-4">
          {step === 'find' ? (
            <FindSaleStep onPick={(id) => router.push(`/returns/new?saleId=${id}`)} />
          ) : null}

          {step === 'select' && saleId ? (
            <Card>
              <CardHeader>
                <CardTitle>Select items to return</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                  items.map((it) => {
                    const sel = draft.selections[it.saleItemId];
                    const disabled = it.availableReturnQuantity <= 0;
                    return (
                      <div
                        key={it.saleItemId}
                        className={cn(
                          'flex items-center gap-3 rounded-xl border p-3',
                          sel ? 'border-primary bg-brand-50' : 'border-border',
                          disabled && 'opacity-50',
                        )}
                      >
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => toggleItem(it)}
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                            sel ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                          )}
                          aria-label={sel ? 'Deselect' : 'Select'}
                        >
                          {sel ? <Check className="h-4 w-4" /> : null}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{it.productName}</div>
                          <div className="text-xs text-muted-foreground">
                            {it.sku ? `${it.sku} · ` : ''}
                            {formatMoney(it.unitPrice)} · bought {it.purchasedQuantity}
                            {it.previouslyReturnedQuantity > 0
                              ? ` · returned ${it.previouslyReturnedQuantity}`
                              : ''}{' '}
                            · available {it.availableReturnQuantity}
                          </div>
                        </div>
                        {sel ? (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => changeQty(it, -1)}
                              aria-label="Decrease"
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                            <span className="w-8 text-center text-sm font-medium">{sel.returnQuantity}</span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => changeQty(it, 1)}
                              aria-label="Increase"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          ) : null}

          {step === 'details' ? (
            <Card>
              <CardHeader>
                <CardTitle>Reason & condition</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedIds.map((sid) => {
                  const it = items.find((i) => i.saleItemId === sid);
                  const sel = draft.selections[sid];
                  if (!it || !sel) return null;
                  return (
                    <div key={sid} className="rounded-xl border border-border p-3">
                      <div className="mb-3 font-medium">
                        {it.productName}{' '}
                        <span className="text-sm text-muted-foreground">× {sel.returnQuantity}</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label>Reason</Label>
                          <Select
                            value={sel.returnReason ?? 'WRONG_PRODUCT'}
                            onChange={(e) =>
                              draft.setSelection(sid, { returnReason: e.target.value as ReturnReasonCode })
                            }
                          >
                            {RETURN_REASON_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Condition</Label>
                          <Select
                            value={sel.itemCondition ?? 'GOOD'}
                            onChange={(e) => setCondition(sid, e.target.value as ItemConditionCode)}
                          >
                            {ITEM_CONDITION_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Restock</Label>
                          <Select
                            value={sel.stockDisposition ?? 'RETURN_TO_STOCK'}
                            onChange={(e) =>
                              draft.setSelection(sid, {
                                stockDisposition: e.target.value as StockDispositionCode,
                              })
                            }
                          >
                            {STOCK_DISPOSITION_OPTIONS.map((o) => (
                              <option
                                key={o.value}
                                value={o.value}
                                disabled={o.value === 'RETURN_TO_STOCK' && sel.itemCondition !== 'GOOD'}
                              >
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        <Label>Note (optional)</Label>
                        <Textarea
                          value={sel.note ?? ''}
                          onChange={(e) => draft.setSelection(sid, { note: e.target.value })}
                          placeholder="Anything the accountant should know…"
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {step === 'review' ? (
            <Card>
              <CardHeader>
                <CardTitle>Review refund</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {preview?.items.map((it) => (
                  <div key={it.saleItemId} className="flex items-center justify-between text-sm">
                    <span>
                      {it.productName} <span className="text-muted-foreground">× {it.returnQuantity}</span>
                    </span>
                    <span className="font-medium">{formatMoney(it.refundableAmount)}</span>
                  </div>
                ))}
                {needsApproval ? (
                  <div className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning">
                    <div className="font-medium">Manager approval required</div>
                    <ul className="mt-1 list-inside list-disc">
                      {preview?.approvalReasons.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                    <Button className="mt-3" size="sm" onClick={() => setPinOpen(true)}>
                      <ShieldCheck className="h-4 w-4" /> Approve with manager PIN
                    </Button>
                  </div>
                ) : preview?.requiresApproval && draft.approvalToken ? (
                  <div className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
                    <Check className="mr-1 inline h-4 w-4" /> Manager approval recorded
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {step === 'refund' ? (
            <Card>
              <CardHeader>
                <CardTitle>Refund method</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {(preview?.allowedRefundMethods ?? []).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => draft.setRefund(m, draft.refundReference)}
                      className={cn(
                        'rounded-xl border p-3 text-sm font-medium transition-colors',
                        draft.refundMethod === m
                          ? 'border-primary bg-brand-50 text-brand-700'
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {REFUND_METHOD_LABEL[m] ?? m}
                    </button>
                  ))}
                </div>
                {draft.refundMethod && draft.refundMethod !== 'CASH' && draft.refundMethod !== 'STORE_CREDIT' ? (
                  <div className="space-y-1.5">
                    <Label>Reference</Label>
                    <Input
                      value={draft.refundReference ?? ''}
                      onChange={(e) => draft.setRefund(draft.refundMethod, e.target.value)}
                      placeholder="Card terminal / bank reference"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label>Return note (optional)</Label>
                  <Textarea
                    value={draft.notes ?? ''}
                    onChange={(e) => draft.setNotes(e.target.value)}
                    placeholder="Internal note for this return"
                  />
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Step navigation */}
          {saleId ? (
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                onClick={() => setStep(prevStep(step, saleId))}
                disabled={step === 'select'}
              >
                Back
              </Button>
              {step !== 'refund' ? (
                <Button
                  onClick={() => setStep(nextStep(step, saleId))}
                  disabled={!canAdvance(step, hasSelection, preview, needsApproval)}
                >
                  Continue
                </Button>
              ) : (
                <Button onClick={submit} disabled={submitting || !draft.refundMethod || needsApproval}>
                  {submitting ? 'Completing…' : 'Complete return'}
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {/* Right summary — visible throughout */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Refund summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <SummaryRow label="Customer" value={elig?.isCreditCustomer ? 'Credit customer' : 'Customer'} muted />
              <SummaryRow label="Selected items" value={String(selectedIds.length)} />
              {preview ? (
                <>
                  <div className="my-1 border-t border-border" />
                  <SummaryRow label="Returned subtotal" value={formatMoney(preview.subtotal)} />
                  <SummaryRow
                    label="Discount adjustment"
                    value={`-${formatMoney(preview.productDiscountAdjustment + preview.orderDiscountAdjustment)}`}
                  />
                  <SummaryRow label="Tax adjustment" value={formatMoney(preview.taxAdjustment)} />
                  <div className="my-1 border-t border-border" />
                  <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2.5 text-base font-semibold text-brand-700">
                    <span>Refund total</span>
                    <span>{formatMoney(preview.refundTotal)}</span>
                  </div>
                  {preview.requiresApproval ? (
                    <div className="pt-1">
                      <Badge variant={draft.approvalToken ? 'success' : 'warning'}>
                        {draft.approvalToken ? 'Approved' : 'Approval required'}
                      </Badge>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="pt-2 text-muted-foreground">Select items to see the refund.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ManagerPinDialog
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        onApprove={async (pin) => {
          if (!session || !preview) return;
          const res = await approveReturn(session, {
            managerPin: pin,
            originalSaleId: saleId,
            refundTotal: preview.refundTotal,
          });
          if (res.approved && res.approvalToken) {
            draft.setApprovalToken(res.approvalToken);
            approvedForTotal.current = preview.refundTotal;
            setPinOpen(false);
          } else {
            throw new Error(res.reason ?? 'Approval was declined');
          }
        }}
      />
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function StepIndicator({ steps, current }: { steps: Step[]; current: Step }) {
  const idx = steps.indexOf(current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={cn(
              'flex h-7 items-center gap-2 rounded-full px-3 text-xs font-medium',
              i < idx
                ? 'bg-success-soft text-success'
                : i === idx
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {i < idx ? <Check className="h-3.5 w-3.5" /> : <span>{i + 1}</span>}
            {STEP_LABELS[s]}
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={muted ? 'text-muted-foreground' : 'text-foreground'}>{value}</span>
    </div>
  );
}

function FindSaleStep({ onPick }: { onPick: (saleId: string) => void }) {
  const { session } = useAuth();
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<SaleListItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => {
      setLoading(true);
      fetchSales(session, { search: q.trim() || undefined, pageSize: 10 })
        .then((res) => setRows(res.items.filter((s) => s.status === 'COMPLETED')))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [session, q]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Find the original sale</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-10"
            placeholder="Sale number, receipt, or customer name / phone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="divide-y divide-border">
          {loading ? (
            <p className="py-4 text-sm text-muted-foreground">Searching…</p>
          ) : rows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No completed sales found.</p>
          ) : (
            rows.map((s) => (
              <div key={s.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium">{s.saleNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.customerName ?? 'Walk-in'} · {formatMoney(s.total)} ·{' '}
                    {/* Invoice date, so this matches the bill in the customer's
                        hand and the order the list is now sorted in. */}
                    {new Date(s.completedAt ?? s.createdAt).toLocaleDateString('en-LK')}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => onPick(s.id)}>
                  Return
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ManagerPinDialog({
  open,
  onClose,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  onApprove: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onApprove(pin);
      setPin('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Manager approval"
      description="A manager PIN is required to authorise this return."
      className="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || pin.length < 4}>
            {busy ? 'Checking…' : 'Approve'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="pin">Manager PIN</Label>
          <Input
            id="pin"
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
          />
        </div>
        {err ? <p className="text-sm text-danger">{err}</p> : null}
      </div>
    </Dialog>
  );
}

// ── step machine helpers ──────────────────────────────────────────────────────

function nextStep(step: Step, saleId: string): Step {
  const order: Step[] = saleId ? ['select', 'details', 'review', 'refund'] : ['find', 'select', 'details', 'review', 'refund'];
  const i = order.indexOf(step);
  return order[Math.min(order.length - 1, i + 1)] ?? step;
}

function prevStep(step: Step, saleId: string): Step {
  const order: Step[] = saleId ? ['select', 'details', 'review', 'refund'] : ['find', 'select', 'details', 'review', 'refund'];
  const i = order.indexOf(step);
  return order[Math.max(0, i - 1)] ?? step;
}

function canAdvance(
  step: Step,
  hasSelection: boolean,
  preview: ReturnPreview | null,
  needsApproval: boolean,
): boolean {
  if (step === 'select') return hasSelection;
  if (step === 'details') return hasSelection;
  if (step === 'review') return !!preview && !needsApproval;
  return true;
}

function cryptoKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ret-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}
