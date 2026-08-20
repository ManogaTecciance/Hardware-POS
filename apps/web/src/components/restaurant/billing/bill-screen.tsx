'use client';

import {
  CreditCard,
  Minus,
  Plus,
  Printer,
  Receipt,
  Trash2,
  Undo2,
  UtensilsCrossed,
} from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { billing } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import { getCachedDocumentProfile } from '@/lib/document-template-service';
import { printSplitBill, reprintCustomerReceipt } from '@/lib/receipt-print';
import { getActiveCurrency } from '@/lib/tenant-money';
import type { BillLineItem, BillView, PaymentMethod } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  saleId: string;
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'QR_PAYMENT', label: 'QR payment' },
  { value: 'CHECK', label: 'Check' },
  { value: 'STORE_CREDIT', label: 'Store credit' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * Bill screen for a closed session.
 *
 * The three things a manager acts on: the split layout, the payments
 * collected against it, and the audit reopen when something goes wrong.
 * Every write goes to the backend — the running totals shown here are
 * whatever the server most recently returned, never an optimistic client
 * calculation.
 */
export function BillScreen({ session, saleId }: Props) {
  const { hasPermission } = useAuth();
  const canSplit = hasPermission(Permission.BILL_SPLIT);
  const canCollect = hasPermission(Permission.PAYMENT_COLLECT);

  const [bill, setBill] = React.useState<BillView | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [showSplitEditor, setShowSplitEditor] = React.useState(false);
  const [showItemSplit, setShowItemSplit] = React.useState(false);
  const [payFor, setPayFor] = React.useState<{ splitId: string | null; suggested: string } | null>(
    null,
  );
  const [reopening, setReopening] = React.useState(false);
  const [printing, setPrinting] = React.useState(false);

  /*
   * D68 — printing the bill is the CASHIER's deliberate act, not something
   * the system does on their behalf. A browser print is the right mechanism
   * for it: a human pressed a button, so the print dialog they get is the
   * one they expect, and it reaches whichever printer that till is set up
   * with. (Automatic, unattended printing is what needed hardware plumbing,
   * and that is exactly what D68 withdrew.)
   */
  const printBill = async () => {
    setPrinting(true);
    setError(null);
    try {
      await reprintCustomerReceipt(session, saleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the bill for printing');
    } finally {
      setPrinting(false);
    }
  };

  const load = React.useCallback(async () => {
    try {
      const b = await billing.get(session, saleId);
      setBill(b);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bill');
      setStatus('error');
    }
  }, [session, saleId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (status === 'loading') {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading bill…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error' || !bill) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-danger">
          {error ?? 'Could not load the bill.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>{bill.saleNumber}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Printer className="h-4 w-4" />}
                isLoading={printing}
                onClick={() => void printBill()}
              >
                Print bill
              </Button>
              <StatusBadge
                label={bill.paymentStatus}
                tone={
                  bill.paymentStatus === 'PAID'
                    ? 'positive'
                    : bill.paymentStatus === 'PARTIAL'
                      ? 'warning'
                      : bill.paymentStatus === 'REFUNDED'
                        ? 'muted'
                        : 'danger'
                }
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Subtotal" value={formatMoney(bill.subtotal)} />
            <Row label="Service charge" value={formatMoney(bill.serviceChargeAmount)} />
            <Row label="Packaging" value={formatMoney(bill.packagingCharge)} />
            <div className="my-2 border-t border-border" />
            <Row label="Total" value={formatMoney(bill.total)} bold />
            <Row label="Paid" value={formatMoney(bill.paidAmount)} muted />
            <Row label="Balance" value={formatMoney(bill.balanceAmount)} bold />
          </CardContent>
        </Card>

        {/* D51 — the lines behind the totals. A restaurant Sale carries no
            SaleItem rows, so these come from the session's orders. */}
        {bill.items.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {bill.items.map((it) => (
                <div
                  key={it.orderItemId}
                  className="flex items-start justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate">
                      {it.name}
                      {it.variantName ? (
                        <span className="ml-1 text-xs text-muted-foreground">{it.variantName}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {trimQuantity(it.quantity)} × {formatMoney(it.unitPrice)}
                    </p>
                  </div>
                  <span className="shrink-0">{formatMoney(it.lineTotal)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Splits</CardTitle>
            {canSplit ? (
              <div className="flex gap-2">
                {bill.items.length > 0 ? (
                  <Button
                    size="sm"
                    onClick={() => setShowItemSplit(true)}
                    leftIcon={<UtensilsCrossed className="h-4 w-4" />}
                  >
                    Split by item
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowSplitEditor(true)}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  By amount
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2">
            {bill.splits.length === 0 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  No splits set. The whole balance can be paid on a single tender.
                </p>
                {canCollect ? (
                  <Button
                    size="sm"
                    leftIcon={<CreditCard className="h-4 w-4" />}
                    onClick={() => setPayFor({ splitId: null, suggested: bill.balanceAmount })}
                    disabled={Number(bill.balanceAmount) <= 0}
                  >
                    Collect payment
                  </Button>
                ) : null}
              </>
            ) : (
              <ul className="space-y-2">
                {bill.splits.map((sp, i) => {
                  const remaining = Number(sp.share) - Number(sp.paidAmount);
                  return (
                    <li key={sp.id} className="rounded-lg border border-border p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{sp.label ?? `Split ${i + 1}`}</span>
                        <span>{formatMoney(sp.share)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>Paid {formatMoney(sp.paidAmount)}</span>
                        <span>Remaining {formatMoney(remaining)}</span>
                      </div>
                      {/* D51 — what this person actually ate. */}
                      {sp.items.length > 0 ? (
                        <ul className="mt-2 space-y-0.5 border-t border-border pt-2 text-xs text-muted-foreground">
                          {sp.items.map((it) => (
                            <li key={it.orderItemId} className="flex justify-between gap-2">
                              <span className="truncate">
                                {trimQuantity(it.quantity)} × {it.name}
                              </span>
                              <span className="shrink-0">{formatMoney(it.lineTotal)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {canCollect ? (
                          <Button
                            size="sm"
                            variant="outline"
                            leftIcon={<CreditCard className="h-4 w-4" />}
                            onClick={() =>
                              setPayFor({ splitId: sp.id, suggested: remaining.toFixed(2) })
                            }
                            disabled={remaining <= 0}
                          >
                            Collect for split
                          </Button>
                        ) : null}
                        {/* D51 — each party gets their own printed bill. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Printer className="h-4 w-4" />}
                          onClick={() =>
                            printSplitBill({
                              storeName:
                                getCachedDocumentProfile().companyName || session.branchName || '',
                              currency: getActiveCurrency(),
                              saleNumber: bill.saleNumber,
                              splitLabel: sp.label ?? `Split ${i + 1}`,
                              items: sp.items,
                              share: sp.share,
                              paidAmount: sp.paidAmount,
                            })
                          }
                        >
                          Print
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Payments</CardTitle>
            <Receipt className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            {bill.payments.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No payments collected yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {bill.payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {PAYMENT_METHODS.find((m) => m.value === p.method)?.label ?? p.method}
                      </p>
                      {p.reference ? (
                        <p className="text-xs text-muted-foreground">Ref: {p.reference}</p>
                      ) : null}
                    </div>
                    <span className="font-semibold">{formatMoney(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {canSplit ? (
          <Card>
            <CardHeader>
              <CardTitle>Reopen bill</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Reopening a closed bill undoes the finalisation so a payment or a split can be
                corrected. The reason is recorded on the audit trail.
              </p>
              <Button
                variant="destructive"
                leftIcon={<Undo2 className="h-4 w-4" />}
                onClick={() => setReopening(true)}
              >
                Reopen bill
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {showItemSplit ? (
        <ItemSplitDialog
          bill={bill}
          onClose={() => setShowItemSplit(false)}
          onSaved={async () => {
            setShowItemSplit(false);
            await load();
          }}
          session={session}
        />
      ) : null}
      {showSplitEditor ? (
        <SplitsEditorDialog
          bill={bill}
          onClose={() => setShowSplitEditor(false)}
          onSaved={async () => {
            setShowSplitEditor(false);
            await load();
          }}
          session={session}
        />
      ) : null}
      {payFor ? (
        <CollectPaymentDialog
          bill={bill}
          suggested={payFor.suggested}
          splitId={payFor.splitId}
          onClose={() => setPayFor(null)}
          onCollected={async () => {
            setPayFor(null);
            await load();
          }}
          session={session}
        />
      ) : null}
      {reopening ? (
        <ReopenDialog
          onClose={() => setReopening(false)}
          onReopened={async () => {
            setReopening(false);
            await load();
          }}
          session={session}
          saleId={saleId}
        />
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        bold ? 'font-semibold' : ''
      } ${muted ? 'text-muted-foreground' : ''}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function SplitsEditorDialog({
  bill,
  onClose,
  onSaved,
  session,
}: {
  bill: BillView;
  onClose: () => void;
  onSaved: () => Promise<void>;
  session: Session;
}) {
  interface Row {
    key: string;
    label: string;
    share: string;
  }
  const [rows, setRows] = React.useState<Row[]>(
    bill.splits.length > 0
      ? bill.splits.map((s, i) => ({
          key: s.id,
          label: s.label ?? `Split ${i + 1}`,
          share: s.share,
        }))
      : [
          { key: 'a', label: 'Split 1', share: '0.00' },
          { key: 'b', label: 'Split 2', share: '0.00' },
        ],
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const total = rows.reduce((s, r) => s + (Number(r.share) || 0), 0);
  const target = Number(bill.total);
  const diff = target - total;

  const submit = async () => {
    if (Math.abs(diff) > 0.005) {
      setError(`Splits must sum to ${formatMoney(bill.total)}. Currently ${formatMoney(total)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await billing.setSplits(session, bill.saleId, {
        splits: rows.map((r) => ({
          label: r.label.trim() || undefined,
          share: Number(r.share),
        })),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save splits');
      setSaving(false);
    }
  };

  const evenSplit = () => {
    const per = target / rows.length;
    setRows((r) => r.map((row) => ({ ...row, share: per.toFixed(2) })));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit bill splits"
      description={`Total to split: ${formatMoney(bill.total)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            isLoading={saving}
            disabled={Math.abs(diff) > 0.005 || rows.length === 0}
          >
            Save splits
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2">
              <Input
                aria-label={`Label for split ${i + 1}`}
                value={r.label}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((row) => (row.key === r.key ? { ...row, label: e.target.value } : row)),
                  )
                }
                className="flex-1"
              />
              <Input
                aria-label={`Amount for split ${i + 1}`}
                value={r.share}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((row) => (row.key === r.key ? { ...row, share: e.target.value } : row)),
                  )
                }
                inputMode="decimal"
                className="w-24 text-right"
              />
              <button
                type="button"
                aria-label={`Remove split ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((row) => row.key !== r.key))}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { key: cryptoRandomKey(), label: `Split ${rs.length + 1}`, share: '0.00' },
              ])
            }
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Add split
          </Button>
          <Button size="sm" variant="ghost" onClick={evenSplit}>
            Even split
          </Button>
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
          <p className="flex items-center justify-between">
            <span>Sum</span>
            <span className="font-semibold">{formatMoney(total)}</span>
          </p>
          <p className="flex items-center justify-between">
            <span>Target</span>
            <span>{formatMoney(bill.total)}</span>
          </p>
          {Math.abs(diff) > 0.005 ? (
            <p className="mt-1 text-danger">
              {diff > 0
                ? `Short by ${formatMoney(diff)}`
                : `Over by ${formatMoney(Math.abs(diff))}`}
            </p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function CollectPaymentDialog({
  bill,
  suggested,
  splitId,
  onClose,
  onCollected,
  session,
}: {
  bill: BillView;
  suggested: string;
  /** D51 — when set, the tender is allocated to this split, not the whole bill. */
  splitId: string | null;
  onClose: () => void;
  onCollected: () => Promise<void>;
  session: Session;
}) {
  const [amount, setAmount] = React.useState(suggested);
  const [method, setMethod] = React.useState<PaymentMethod>('CASH');
  const [reference, setReference] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const numAmount = Number(amount);
  const valid = numAmount > 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await billing.collectPayment(session, bill.saleId, {
        amount: numAmount,
        method,
        reference: reference.trim() || undefined,
        splitId: splitId ?? undefined,
      });
      await onCollected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Collect payment"
      description={`Bill balance: ${formatMoney(bill.balanceAmount)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!valid}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-amount">
            Amount
          </label>
          <Input
            id="pay-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-method">
            Method
          </label>
          <select
            id="pay-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-reference">
            Reference (optional)
          </label>
          <Input
            id="pay-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Auth code, cheque #, etc."
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function ReopenDialog({
  onClose,
  onReopened,
  session,
  saleId,
}: {
  onClose: () => void;
  onReopened: () => Promise<void>;
  session: Session;
  saleId: string;
}) {
  const [reason, setReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await billing.reopen(session, saleId, { reason: reason.trim() });
      await onReopened();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reopen bill');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Reopen this bill?"
      description="Records the reason on the audit trail so finance can trace the correction."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            isLoading={saving}
            disabled={!reason.trim()}
          >
            Reopen bill
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="text-sm font-medium" htmlFor="reopen-reason">
          Reason
        </label>
        <Input
          id="reopen-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Wrong tender captured"
          autoFocus
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function cryptoRandomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "2.000" reads badly on a bill; "2" and "0.5" do. */
function trimQuantity(q: string): string {
  return String(Number(q));
}

interface DraftSplit {
  key: string;
  label: string;
  /** orderItemId → assigned quantity for this split. */
  assigned: Map<string, number>;
}

/**
 * D51 — split the bill by what each person ate.
 *
 * Interaction: pick whose bill you are building (the chips), then add lines to
 * it. A line with several units can be shared — the stepper moves one unit at
 * a time — which is what makes "a round of three beers, one each" expressible.
 * Save stays disabled until every unit is assigned, because the server refuses
 * a partial division: the shares have to sum to the bill total exactly.
 */
function ItemSplitDialog({
  bill,
  onClose,
  onSaved,
  session,
}: {
  bill: BillView;
  onClose: () => void;
  onSaved: () => Promise<void>;
  session: Session;
}) {
  const [splits, setSplits] = React.useState<DraftSplit[]>(() => [
    { key: cryptoRandomKey(), label: 'Guest 1', assigned: new Map() },
    { key: cryptoRandomKey(), label: 'Guest 2', assigned: new Map() },
  ]);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const active = splits.find((s) => s.key === activeKey) ?? splits[0];
  React.useEffect(() => {
    if (!activeKey && splits[0]) setActiveKey(splits[0].key);
  }, [activeKey, splits]);

  const assignedTotal = (itemId: string) =>
    splits.reduce((n, s) => n + (s.assigned.get(itemId) ?? 0), 0);
  const remainingOf = (item: BillLineItem) =>
    Number(item.quantity) - assignedTotal(item.orderItemId);
  const unassignedUnits = bill.items.reduce((n, it) => n + remainingOf(it), 0);

  const splitSubtotal = (split: DraftSplit) =>
    bill.items.reduce((sum, it) => {
      const qty = split.assigned.get(it.orderItemId) ?? 0;
      return sum + qty * Number(it.unitPrice);
    }, 0);

  const mutateActive = (fn: (m: Map<string, number>) => void) => {
    if (!active) return;
    setSplits((prev) =>
      prev.map((s) => {
        if (s.key !== active.key) return s;
        const next = new Map(s.assigned);
        fn(next);
        return { ...s, assigned: next };
      }),
    );
  };

  const add = (item: BillLineItem, units: number) => {
    const room = remainingOf(item);
    const step = Math.min(units, room);
    if (step <= 0) return;
    mutateActive((m) => m.set(item.orderItemId, (m.get(item.orderItemId) ?? 0) + step));
  };
  const remove = (item: BillLineItem, units: number) => {
    mutateActive((m) => {
      const cur = m.get(item.orderItemId) ?? 0;
      const next = Math.max(0, cur - units);
      if (next === 0) m.delete(item.orderItemId);
      else m.set(item.orderItemId, next);
    });
  };

  const addSplit = () =>
    setSplits((prev) => {
      const next = [
        ...prev,
        { key: cryptoRandomKey(), label: `Guest ${prev.length + 1}`, assigned: new Map() },
      ];
      return next;
    });

  const removeSplit = (key: string) =>
    setSplits((prev) => {
      const next = prev.filter((s) => s.key !== key);
      if (key === activeKey) setActiveKey(next[0]?.key ?? null);
      return next;
    });

  const nonEmpty = splits.filter((s) => s.assigned.size > 0);
  const valid = unassignedUnits === 0 && nonEmpty.length > 0;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await billing.splitByItems(session, bill.saleId, {
        splits: nonEmpty.map((s) => ({
          label: s.label.trim() || undefined,
          items: [...s.assigned.entries()].map(([orderItemId, quantity]) => ({
            orderItemId,
            quantity,
          })),
        })),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to split the bill');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Split by item"
      description="Pick whose bill you are building, then add what they had. Every item must be assigned."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving} disabled={!valid}>
            Create {nonEmpty.length || ''} bill{nonEmpty.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {/* Whose bill am I building? */}
        <div className="flex flex-wrap items-center gap-2">
          {splits.map((s) => {
            const isActive = s.key === active?.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveKey(s.key)}
                className={
                  'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ' +
                  (isActive ? 'border-primary bg-primary/10 font-medium' : 'border-border')
                }
              >
                <span>{s.label}</span>
                <span className="text-xs text-muted-foreground">
                  {formatMoney(splitSubtotal(s).toFixed(2))}
                </span>
              </button>
            );
          })}
          <Button
            size="sm"
            variant="outline"
            onClick={addSplit}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Add guest
          </Button>
        </div>

        {active ? (
          <div className="flex items-center gap-2">
            <Input
              value={active.label}
              aria-label="Guest name"
              onChange={(e) =>
                setSplits((prev) =>
                  prev.map((s) => (s.key === active.key ? { ...s, label: e.target.value } : s)),
                )
              }
              placeholder="Name on this bill"
            />
            {splits.length > 1 ? (
              <Button
                size="icon-md"
                variant="ghost"
                aria-label={`Remove ${active.label}`}
                onClick={() => removeSplit(active.key)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* The lines */}
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
          {bill.items.map((it) => {
            const mine = active?.assigned.get(it.orderItemId) ?? 0;
            const left = remainingOf(it);
            const others = assignedTotal(it.orderItemId) - mine;
            return (
              <div
                key={it.orderItemId}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-muted"
              >
                <div className="min-w-0">
                  <p className="truncate">
                    {it.name}
                    {it.variantName ? (
                      <span className="ml-1 text-xs text-muted-foreground">{it.variantName}</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(it.unitPrice)} each · {trimQuantity(it.quantity)} total
                    {others > 0 ? ` · ${trimQuantity(String(others))} with others` : ''}
                    {left > 0 ? (
                      <span className="text-warning">
                        {' '}
                        · {trimQuantity(String(left))} unassigned
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove one ${it.name}`}
                    disabled={mine <= 0}
                    onClick={() => remove(it, 1)}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="w-6 text-center tabular-nums">{trimQuantity(String(mine))}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Add one ${it.name}`}
                    disabled={left <= 0}
                    onClick={() => add(it, 1)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className={unassignedUnits > 0 ? 'text-warning' : 'text-success'}>
            {unassignedUnits > 0
              ? `${trimQuantity(String(unassignedUnits))} item${unassignedUnits === 1 ? '' : 's'} still unassigned`
              : 'Everything assigned'}
          </span>
          {unassignedUnits > 0 && active ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => bill.items.forEach((it) => add(it, remainingOf(it)))}
            >
              Assign rest to {active.label}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Service charge and other bill-level amounts are shared across the new bills in proportion
          to what each covers.
        </p>
      </div>
    </Dialog>
  );
}
