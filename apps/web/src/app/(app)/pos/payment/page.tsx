'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Minus,
  Plus,
  Printer,
  ReceiptText,
  ShoppingCart,
  Trash2,
} from 'lucide-react';

import { NumericKeypad, QuickAmountButtons } from '@/components/pos/payment/numeric-keypad';
import { PaymentMethodSelector, type Mode } from '@/components/pos/payment/payment-method-selector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCachedDocumentProfile } from '@/lib/document-template-service';
import { Select } from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/lib/auth';
import {
  computeLine,
  linePrice,
  computeTotals,
  type CartItem,
  type CartLineKey,
} from '@/lib/cart';
import { useCheckoutData } from '@/lib/catalog';
import { usePosCart } from '@/lib/pos-cart';
import { printCustomerReceipt, type ReceiptContext } from '@/lib/receipt-print';
import {
  completeSale,
  saleLocation,
  type CompletedSale,
  type CompleteSaleDto,
  type PaymentMethodCode,
} from '@/lib/sales';
import { cn, formatMoney, round2 } from '@/lib/utils';

const SPLIT_METHODS: { value: PaymentMethodCode; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
  { value: 'QR_PAYMENT', label: 'QR Payment' },
  { value: 'CHECK', label: 'Cheque' },
];

interface SplitLine {
  id: number;
  method: PaymentMethodCode;
  amount: string;
  reference: string;
}

let splitLineSeq = 1;

/** Open the shell-free A4 bill route for a sale (optionally auto-printing). */
function openA4Bill(saleId: string, print = false): void {
  window.open(`/print/sales/${saleId}${print ? '?print=1' : ''}`, '_blank', 'noopener');
}

export default function PaymentPage() {
  const { session } = useAuth();
  const router = useRouter();
  const data = useCheckoutData(session!);
  const cart = usePosCart();

  const currency = data.settings.currency;
  const totals = computeTotals(cart.items, data.settings.taxRatePercent, cart.orderDiscount);
  const total = totals.total;

  const [mode, setMode] = React.useState<Mode>('CASH');
  const [tendered, setTendered] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [partialAmount, setPartialAmount] = React.useState('');
  const [partialMethod, setPartialMethod] = React.useState<PaymentMethodCode>('CASH');
  const [splitLines, setSplitLines] = React.useState<SplitLine[]>([]);
  const [printAfter, setPrintAfter] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [completed, setCompleted] = React.useState<CompletedSale | null>(null);
  const [receiptCtx, setReceiptCtx] = React.useState<ReceiptContext | null>(null);
  const [printing, setPrinting] = React.useState(false);
  const [summaryOpen, setSummaryOpen] = React.useState(false);

  // Selected customers always pass through cart.addCustomer, so the cart's own
  // list is sufficient to resolve the display name.
  const customerName =
    cart.addedCustomers.find((c) => c.id === cart.customerId)?.name ?? 'Walk-in customer';
  const hasCustomer = !!cart.customerId;

  // Redirect back to the cart if it emptied (but not right after a successful sale).
  React.useEffect(() => {
    if (cart.hydrated && cart.items.length === 0 && !completed) {
      router.replace('/pos');
    }
  }, [cart.hydrated, cart.items.length, completed, router]);

  React.useEffect(() => {
    setTendered(total ? total.toFixed(2) : '');
  }, [total]);

  // ── derive payments from the selected mode ─────────────────────────────────
  const splitPaid = round2(splitLines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

  let paidAmount = 0;
  let payments: { method: PaymentMethodCode; amount: number; reference?: string }[] = [];
  if (mode === 'CASH') {
    paidAmount = total;
    payments = [{ method: 'CASH', amount: total }];
  } else if (
    mode === 'CARD' ||
    mode === 'BANK_TRANSFER' ||
    mode === 'QR_PAYMENT' ||
    mode === 'CHECK'
  ) {
    paidAmount = total;
    payments = [{ method: mode, amount: total, reference: reference.trim() || undefined }];
  } else if (mode === 'PARTIAL') {
    paidAmount = round2(Number(partialAmount) || 0);
    payments =
      paidAmount > 0
        ? [{ method: partialMethod, amount: paidAmount, reference: reference.trim() || undefined }]
        : [];
  } else if (mode === 'SPLIT') {
    paidAmount = splitPaid;
    payments = splitLines
      .filter((l) => (Number(l.amount) || 0) > 0)
      .map((l) => ({
        method: l.method,
        amount: round2(Number(l.amount)),
        reference: l.reference.trim() || undefined,
      }));
  } else {
    // CREDIT
    paidAmount = 0;
    payments = [];
  }

  const tenderedNum = Number(tendered) || 0;
  const balance = Math.max(0, round2(total - paidAmount));
  const change = mode === 'CASH' ? round2(Math.max(0, tenderedNum - total)) : 0;
  const cashShort = mode === 'CASH' ? round2(Math.max(0, total - tenderedNum)) : 0;
  const needsCustomer = paidAmount < total; // partial or credit → invoice needs a customer

  const invalid =
    submitting ||
    cart.items.length === 0 ||
    totals.hasStockIssue ||
    (needsCustomer && !hasCustomer) ||
    (mode === 'CASH' && tenderedNum < total) ||
    (mode === 'PARTIAL' && (paidAmount <= 0 || paidAmount >= total)) ||
    (mode === 'SPLIT' && (payments.length === 0 || paidAmount > total));

  // Human-readable explanation for a disabled Complete Payment button (surfaced
  // inline above the footer, and available to screen readers).
  let disabledReason: string | null = null;
  if (!submitting) {
    if (totals.hasStockIssue) {
      disabledReason = 'Some items exceed available stock — adjust quantities in the cart.';
    } else if (needsCustomer && !hasCustomer) {
      disabledReason = 'Select a customer to record a credit or partial sale.';
    } else if (mode === 'CASH' && tenderedNum < total) {
      disabledReason = `Enter at least ${formatMoney(total, currency)} to complete this cash payment.`;
    } else if (mode === 'PARTIAL' && paidAmount <= 0) {
      disabledReason = 'Enter the amount the customer is paying now.';
    } else if (mode === 'PARTIAL' && paidAmount >= total) {
      disabledReason =
        'Partial amount must be less than the total — use a full payment method instead.';
    } else if (mode === 'SPLIT' && payments.length === 0) {
      disabledReason = 'Add at least one split payment.';
    } else if (mode === 'SPLIT' && paidAmount > total) {
      disabledReason = 'Split total is more than the amount due.';
    }
  }

  const numpadTarget = mode === 'CASH' ? 'tendered' : mode === 'PARTIAL' ? 'partial' : null;
  const appendDigit = (d: string) => {
    if (!numpadTarget) return;
    const set = numpadTarget === 'tendered' ? setTendered : setPartialAmount;
    set((prev) => {
      if (d === 'back') return prev.slice(0, -1);
      if (d === '00') return prev === '' ? prev : prev + '00';
      if (d === '.' && prev.includes('.')) return prev;
      return prev + d;
    });
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    setError(null);
    if (next === 'SPLIT' && splitLines.length === 0) {
      setSplitLines([
        { id: splitLineSeq++, method: 'CASH', amount: total.toFixed(2), reference: '' },
      ]);
    }
  };

  const addSplitLine = () =>
    setSplitLines((lines) => [
      ...lines,
      { id: splitLineSeq++, method: 'CASH', amount: String(balance || ''), reference: '' },
    ]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const dto: CompleteSaleDto = {
        ...saleLocation(session!),
        customerId: cart.customerId || undefined,
        items: cart.items.map((it) => ({
          productId: it.product.id,
          quantity: it.quantity,
          discountType: it.discount?.type,
          discountValue: it.discount?.value,
          discountReason: it.discount?.reason,
          approvalToken: it.approvalToken,
        })),
        payments,
        orderDiscountType: cart.orderDiscount?.type,
        orderDiscountValue: cart.orderDiscount?.value,
        orderDiscountReason: cart.orderDiscount?.reason,
        orderApprovalToken: cart.orderApprovalToken,
      };
      const sale = await completeSale(session!, dto);
      const ctx: ReceiptContext = {
        currency,
        customerName,
        items: cart.items,
        subtotal: totals.subtotal,
        totalDiscount: totals.totalDiscount,
        orderDiscount: totals.orderDiscountAmount,
        taxAmount: totals.taxAmount,
        storeName: getCachedDocumentProfile().companyName || undefined,
      };
      setReceiptCtx(ctx);
      setCompleted(sale);
      cart.clearCart();
      // A4 is the default bill for this client: auto-open the A4 print view
      // (not the old thermal receipt) when "print after payment" is on.
      if (printAfter) openA4Bill(sale.id, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the sale');
      // The failure may be another register beating us to the stock (or a
      // price change) — refresh the catalog so the cart reflects reality.
      data.reload();
    } finally {
      setSubmitting(false);
    }
  };

  const tryComplete = () => {
    if (!invalid) submit();
  };

  // Push freshly loaded catalog data into the cart's product snapshots so
  // stock warnings and totals track reality after a reload.
  React.useEffect(() => {
    if (!data.loading && !data.error) cart.refreshProducts(data.products);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.products, data.loading, data.error]);

  const printReceipt = async () => {
    if (!completed || !receiptCtx) return;
    setPrinting(true);
    try {
      await printCustomerReceipt(session!, completed, receiptCtx);
    } finally {
      setPrinting(false);
    }
  };

  // ── success screen ─────────────────────────────────────────────────────────
  if (completed) {
    return (
      <SuccessView
        sale={completed}
        currency={currency}
        printing={printing}
        onPreviewA4={() => openA4Bill(completed.id)}
        onPrintA4={() => openA4Bill(completed.id, true)}
        onPrintThermal={printReceipt}
        onViewSale={() => router.push(`/sales/${completed.id}`)}
        onNewSale={() => router.push('/pos')}
      />
    );
  }

  return (
    // Viewport-locked on lg+ so the Complete Payment action never scrolls off:
    // the shell gives this page a definite height, and each panel owns an
    // independent scroll region. `min-w-0` on every flex/grid child keeps long
    // LKR labels from forcing horizontal page overflow.
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0">
        <h1 className="text-2xl font-semibold tracking-tight">Payment</h1>
        <p className="truncate text-sm text-muted-foreground">{customerName}</p>
      </div>

      {/* Order summary ~40% · payment workspace ~60% once we clear the tablet
          landscape breakpoint (900px). Below `tab:` — iPad portrait 768–834 —
          the summary collapses into a Sheet triggered from the workspace
          header, because a two-column split at 800px squeezes the numeric
          keypad and the order table into unusable widths. */}
      <div className="grid min-h-0 min-w-0 flex-1 gap-4 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* ── Order summary (tablet-landscape and up) ── */}
        <div className="hidden min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm tab:flex tab:max-h-full tab:self-start">
          <OrderSummary
            items={cart.items}
            totals={totals}
            currency={currency}
            taxRatePercent={data.settings.taxRatePercent}
            total={total}
            onChangeQty={cart.changeQty}
          />
        </div>

        {/* ── Unified payment workspace: fixed top · scroll middle · fixed bottom ── */}
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          {/* Compact order-summary trigger — only below tab:. The Sheet it
              opens is height="full" so the long items list plus totals fit
              without the operator hunting for the primary action. */}
          <button
            type="button"
            onClick={() => setSummaryOpen(true)}
            className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 text-left tab:hidden"
            aria-label="View order summary"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <ReceiptText className="h-4 w-4 text-muted-foreground" aria-hidden />
              Order summary · {totals.itemCount} {totals.itemCount === 1 ? 'item' : 'items'}
            </span>
            <span className="font-semibold text-primary">{formatMoney(total, currency)}</span>
          </button>

          {/* TOP ZONE — Amount due + selected method (always visible). */}
          <div className="grid shrink-0 grid-cols-1 gap-4 p-5 sm:grid-cols-2 sm:items-center">
            <div>
              <div className="text-sm text-muted-foreground">Amount Due</div>
              <div className="text-3xl font-bold tracking-tight text-primary">
                {formatMoney(total, currency)}
              </div>
            </div>
            <div className="rounded-2xl border border-border p-3 sm:border-0 sm:border-l sm:border-border sm:pl-5">
              <PaymentMethodSelector value={mode} onChange={selectMode} />
            </div>
          </div>

          {/* MIDDLE ZONE — only region that scrolls when height is tight. */}
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-5">
            {mode === 'CASH' ? (
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="tendered">Amount Received</Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                        Rs.
                      </span>
                      <Input
                        id="tendered"
                        inputMode="decimal"
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        className="h-12 pl-11 text-lg font-semibold"
                      />
                    </div>
                  </div>

                  {cashShort > 0 ? (
                    <div className="flex items-center justify-between rounded-xl bg-danger-soft px-4 py-3">
                      <span className="text-sm font-medium text-danger">Short by</span>
                      <span className="text-lg font-bold text-danger">
                        {formatMoney(cashShort, currency)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-xl bg-success-soft px-4 py-3">
                      <span className="flex items-center gap-2 text-sm font-medium text-success">
                        Change
                      </span>
                      <span className="flex items-center gap-2 text-lg font-bold text-success">
                        {formatMoney(change, currency)}
                        <CheckCircle2 className="h-5 w-5" aria-label="Sufficient amount received" />
                      </span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="text-sm font-medium text-muted-foreground">Quick Amounts</div>
                    <QuickAmountButtons
                      total={total}
                      selected={tenderedNum}
                      onPick={(n) => setTendered(n.toFixed(2))}
                    />
                  </div>
                </div>

                <NumericKeypad
                  onPress={appendDigit}
                  onEnter={tryComplete}
                  enterDisabled={invalid}
                />
              </div>
            ) : null}

            {mode === 'CARD' ||
            mode === 'BANK_TRANSFER' ||
            mode === 'QR_PAYMENT' ||
            mode === 'CHECK' ? (
              <div className="max-w-md space-y-1.5">
                <Label htmlFor="ref">
                  {mode === 'CHECK' ? 'Cheque number' : 'Reference'} (optional)
                </Label>
                <Input
                  id="ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder={mode === 'CHECK' ? 'e.g. cheque no.' : 'e.g. txn / auth ref'}
                />
                <p className="text-xs text-muted-foreground">
                  Full amount of {formatMoney(total, currency)} will be recorded as paid.
                </p>
              </div>
            ) : null}

            {mode === 'PARTIAL' ? (
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="partial">Amount paid now</Label>
                    <Input
                      id="partial"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={partialAmount}
                      onChange={(e) => setPartialAmount(e.target.value)}
                      className="h-12 text-lg font-semibold"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pmethod">Paid by</Label>
                    <Select
                      id="pmethod"
                      value={partialMethod}
                      onChange={(e) => setPartialMethod(e.target.value as PaymentMethodCode)}
                    >
                      {SPLIT_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-muted px-4 py-3 text-sm">
                    <span className="text-muted-foreground">Remaining balance</span>
                    <span className="font-semibold">{formatMoney(balance, currency)}</span>
                  </div>
                </div>
                <NumericKeypad
                  onPress={appendDigit}
                  onEnter={tryComplete}
                  enterDisabled={invalid}
                />
              </div>
            ) : null}

            {mode === 'SPLIT' ? (
              <div className="max-w-xl space-y-3">
                {splitLines.map((l, i) => (
                  <div key={l.id} className="flex items-center gap-2">
                    <Select
                      value={l.method}
                      onChange={(e) =>
                        setSplitLines((ls) =>
                          ls.map((x) =>
                            x.id === l.id
                              ? { ...x, method: e.target.value as PaymentMethodCode }
                              : x,
                          ),
                        )
                      }
                      className="w-36"
                    >
                      {SPLIT_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                    <Input
                      inputMode="decimal"
                      value={l.amount}
                      placeholder="0.00"
                      className="min-w-0 flex-1"
                      onChange={(e) =>
                        setSplitLines((ls) =>
                          ls.map((x) => (x.id === l.id ? { ...x, amount: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-danger"
                      aria-label="Remove payment"
                      onClick={() => setSplitLines((ls) => ls.filter((x) => x.id !== l.id))}
                      disabled={splitLines.length <= 1 && i === 0}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addSplitLine}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Add payment
                </Button>
                <div className="flex items-center justify-between rounded-xl bg-muted px-4 py-3 text-sm">
                  <span className="text-muted-foreground">Remaining</span>
                  <span
                    className={cn('font-semibold', balance > 0 ? 'text-danger' : 'text-success')}
                  >
                    {formatMoney(balance, currency)}
                  </span>
                </div>
              </div>
            ) : null}

            {mode === 'CREDIT' ? (
              <p className="max-w-md rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                The full {formatMoney(total, currency)} will be recorded as credit (an Invoice). A
                saved customer is required.
              </p>
            ) : null}

            {error ? (
              <p
                className="mt-4 rounded-xl bg-danger-soft px-4 py-2.5 text-sm font-medium text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          {/* BOTTOM ZONE — paid/balance, print, actions (always visible). */}
          <div className="shrink-0 space-y-3 border-t border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-wrap items-center gap-x-10 gap-y-1 text-sm">
              <div>
                <div className="text-muted-foreground">Paid Amount</div>
                <div className="font-semibold">{formatMoney(paidAmount, currency)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{change > 0 ? 'Change' : 'Balance'}</div>
                <div
                  className={cn(
                    'font-semibold',
                    change > 0 ? 'text-success' : balance > 0 ? 'text-danger' : 'text-success',
                  )}
                >
                  {formatMoney(change > 0 ? change : balance, currency)}
                </div>
              </div>
            </div>

            {invalid && disabledReason ? (
              <p
                className="rounded-xl bg-warning-soft px-3 py-2 text-xs font-medium text-warning"
                role="status"
              >
                {disabledReason}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Printer className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span id="print-a4-label">Print A4 bill after payment</span>
                <Switch
                  checked={printAfter}
                  onCheckedChange={setPrintAfter}
                  aria-labelledby="print-a4-label"
                />
              </div>

              <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-initial">
                <Button
                  variant="outline"
                  size="lg"
                  className="shrink-0 border-primary text-primary hover:bg-brand-50"
                  onClick={() => router.push('/pos')}
                  leftIcon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back to Cart
                </Button>
                <Button
                  size="lg"
                  className="min-w-0 flex-1 sm:flex-initial"
                  disabled={invalid}
                  isLoading={submitting}
                  onClick={submit}
                  leftIcon={<CheckCircle2 className="h-5 w-5" />}
                >
                  Complete Payment
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Order-summary sheet for portrait/narrow screens. `height="full"`
          because the summary is item-list + totals + tax + optional discounts
          — capping it at `max-h-[85dvh]` (Sheet default) would hide the grand
          total on a cart with a dozen items on iPad portrait. The Sheet has
          its own header X and safe-area footer, so the negative margins the
          old Dialog wrapper needed are gone; `-mx-6 -my-3` neutralises the
          Sheet body padding so `OrderSummary` fills edge-to-edge. */}
      <Sheet
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        title="Order summary"
        height="full"
      >
        <div className="-mx-6 -my-3 flex h-full min-h-0 flex-col">
          <OrderSummary
            items={cart.items}
            totals={totals}
            currency={currency}
            taxRatePercent={data.settings.taxRatePercent}
            total={total}
            onChangeQty={cart.changeQty}
            hideHeader
          />
        </div>
      </Sheet>
    </div>
  );
}

/**
 * Order-summary body: header with item-count badge, an item table that scrolls
 * independently for large orders (sticky header) with subtotal/discount/tax/
 * grand-total pinned directly beneath the items. Shared by the desktop card and
 * the mobile drawer.
 */
function OrderSummary({
  items,
  totals,
  currency,
  taxRatePercent,
  total,
  onChangeQty,
  hideHeader,
}: {
  items: CartItem[];
  totals: ReturnType<typeof computeTotals>;
  currency: string;
  taxRatePercent: number;
  total: number;
  onChangeQty: (lineKey: CartLineKey, delta: number) => void;
  hideHeader?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      {hideHeader ? null : (
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-primary" aria-hidden />
            <span className="text-lg font-semibold tracking-tight">Order Summary</span>
          </div>
          <Badge variant="primary">
            {totals.itemCount} {totals.itemCount === 1 ? 'item' : 'items'}
          </Badge>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-y border-border bg-muted text-left text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-3 py-2.5 text-right font-medium">Unit Price</th>
              <th className="px-3 py-2.5 text-center font-medium">Qty</th>
              <th className="px-4 py-2.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const line = computeLine(it);
              return (
                <tr
                  key={it.product.id}
                  className="border-b border-border last:border-0 align-middle"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium leading-tight">{it.product.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {it.product.sku ? `SKU: ${it.product.sku}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {formatMoney(linePrice(it), currency)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label={`Decrease ${it.product.name} quantity`}
                        onClick={() => onChangeQty(it.lineKey, -1)}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-7 text-center font-semibold tabular-nums">
                        {it.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label={`Increase ${it.product.name} quantity`}
                        onClick={() => onChangeQty(it.lineKey, 1)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="font-semibold">{formatMoney(line.lineTotal, currency)}</div>
                    {line.discountAmount > 0 ? (
                      <div className="text-xs font-medium text-success">
                        -{formatMoney(line.discountAmount, currency)}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 space-y-1.5 border-t border-border p-4 text-sm">
        <Row label="Subtotal" value={formatMoney(totals.subtotal, currency)} />
        {totals.totalDiscount > 0 ? (
          <Row
            label="Product Discount"
            value={`- ${formatMoney(totals.totalDiscount, currency)}`}
            tone="success"
          />
        ) : null}
        {totals.orderDiscountAmount > 0 ? (
          <Row
            label="Order Discount"
            value={`- ${formatMoney(totals.orderDiscountAmount, currency)}`}
            tone="success"
          />
        ) : null}
        <Row
          label={`Tax / VAT (${taxRatePercent}%)`}
          value={formatMoney(totals.taxAmount, currency)}
        />
        <div className="mt-1 flex items-center justify-between rounded-lg bg-brand-50 px-3 py-3 text-base font-semibold text-brand-700">
          <span>Grand Total</span>
          <span className="text-lg">{formatMoney(total, currency)}</span>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger';
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-medium',
          tone === 'success' && 'text-success',
          tone === 'danger' && 'font-semibold text-danger',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SuccessView({
  sale,
  currency,
  printing,
  onPreviewA4,
  onPrintA4,
  onPrintThermal,
  onViewSale,
  onNewSale,
}: {
  sale: CompletedSale;
  currency: string;
  printing: boolean;
  onPreviewA4: () => void;
  onPrintA4: () => void;
  onPrintThermal: () => void;
  onViewSale?: () => void;
  onNewSale: () => void;
}) {
  return (
    <Dialog open onClose={onNewSale} className="max-w-sm">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="h-8 w-8" />
        </span>
        <h2 className="mt-3 text-lg font-semibold">Payment complete</h2>
        <p className="text-sm text-muted-foreground">Sale {sale.saleNumber}</p>

        <div className="mt-5 w-full space-y-2 rounded-xl border border-border p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount paid</span>
            <span className="font-medium">{formatMoney(sale.paidAmount, currency)}</span>
          </div>
          {sale.balanceAmount > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="font-semibold text-danger">
                {formatMoney(sale.balanceAmount, currency)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between pt-1">
            <span className="text-muted-foreground">Sync status</span>
            <Badge variant="warning">
              <Clock className="h-3.5 w-3.5" />
              Waiting to Sync
            </Badge>
          </div>
        </div>

        <div className="mt-5 grid w-full gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={onPreviewA4}
              leftIcon={<ReceiptText className="h-4 w-4" />}
            >
              Preview A4 Bill
            </Button>
            <Button size="lg" onClick={onPrintA4} leftIcon={<Printer className="h-4 w-4" />}>
              Print A4 Bill
            </Button>
          </div>
          <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
            {onViewSale ? (
              <button onClick={onViewSale} className="font-medium text-primary hover:underline">
                View sale
              </button>
            ) : null}
            <span aria-hidden>·</span>
            <button
              onClick={onPrintThermal}
              disabled={printing}
              className="font-medium hover:underline disabled:opacity-50"
            >
              {printing ? 'Preparing…' : 'Thermal receipt'}
            </button>
          </div>
          <Button
            size="lg"
            onClick={onNewSale}
            leftIcon={<Plus className="h-4 w-4" />}
            className="mt-1"
          >
            New sale
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
