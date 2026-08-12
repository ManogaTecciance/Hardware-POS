'use client';

import { AlertTriangle, ChevronUp, Percent, ReceiptText, ShoppingCart, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { Sheet } from '@/components/ui/sheet';
import { ApiError } from '@/lib/api';
import { useAuth, type Session } from '@/lib/auth';
import { discountLimitFor, withinDiscountLimit, Permission } from '@/lib/permissions';
import { restaurantConfig, takeaway } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView } from '@/lib/restaurant/types';

import { CustomerCapturePopup, type ChosenCustomer } from './counter/customer-capture-popup';
import { ItemDiscountDialog, type LineDiscount } from './counter/item-discount-dialog';
import { OrderCompletionScreen, type CompletionSummary } from './counter/order-completion-screen';
import { PaymentPopup } from './counter/payment-popup';
import { RunningBillSummary } from './counter/running-bill-summary';
import { ModifierPickerDialog } from './modifier-picker-dialog';
import { PosMenuBrowser } from './pos-menu-browser';
import { PosModeChip } from './pos-mode-chip';
import type { PosMode } from './pos-mode-selector';
import { PosOrderTypeModal } from './pos-order-type-modal';
import type { DraftLine } from './pos-types';
import { cryptoRandomKey, draftSubtotal } from './pos-utils';
import { useMenuData } from './use-menu-data';

interface Props {
  session: Session;
  branchId: string;
  initialMode: PosMode | null;
  onModeChange: (mode: PosMode | null) => void;
}

/**
 * The counter-POS workspace — covers three modes in one screen because
 * they share the composition surface (menu + cart) and only diverge at
 * the checkout tail (customer form + payment method + auto-KOT rules).
 *
 * Flow (all three modes):
 *   Menu grid + editable cart with per-line Discount/Edit/Remove
 *   → Place Order
 *   → Customer capture popup (Skip for dine-in/takeaway, required for delivery)
 *   → Payment popup (COD-only for delivery)
 *   → Server orchestration: takeaway.create (kicks the auto-KOT) →
 *     for dine-in/takeaway: advance to HANDED_OVER (creates Sale) →
 *     collect payment. For delivery: leave the Sale UNPAID and rely on
 *     riders to mark handover later.
 *   → Completion screen with KOT + receipt indicators → New Order resets.
 *
 * What is NOT here (backend gaps flagged in the audit):
 *   * Per-item discount does not persist on `RestaurantOrderItem` — the
 *     display shows the discount, but the server records the sum only
 *     as `Sale.discountAmount` if the future backend fix wires it. For
 *     the pilot the discount is client-side reconciliation only, and
 *     the running bill is honest about that.
 *   * Customer link uses `customerName` + `customerPhone` strings —
 *     `TakeawayOrderProfile` has no `customerId` FK today.
 *   * Delivery address rides in `notes` with a `[Delivery]` prefix.
 *   * Cash tendered/change is displayed but the payment row records
 *     only the amount actually charged.
 */
export function PosCounterWorkspace({ session, branchId, initialMode, onModeChange }: Props) {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canPlaceTakeaway = hasPermission(Permission.TAKEAWAY_CREATE);
  const canDiscount = hasPermission(Permission.DISCOUNT_APPROVE);
  const discountLimit = discountLimitFor(session.user.role);

  const [mode, setMode] = React.useState<PosMode | null>(initialMode);
  const { data: menuData, loading: menuLoading } = useMenuData(session, branchId);

  const [draft, setDraft] = React.useState<DraftLine[]>([]);
  const [modifierTarget, setModifierTarget] = React.useState<{
    item: MenuItemView;
    /** Present when re-opening the dialog for an existing cart line. */
    editingKey?: string;
  } | null>(null);
  const [discountTargetKey, setDiscountTargetKey] = React.useState<string | null>(null);

  const [stage, setStage] = React.useState<
    'compose' | 'customer' | 'payment' | 'completed'
  >('compose');
  const [customer, setCustomer] = React.useState<ChosenCustomer | null>(null);
  const [completion, setCompletion] = React.useState<CompletionSummary | null>(null);

  // Portrait tablets and phones hide the cart aside — the cart lives in a
  // bottom Sheet reached from a sticky "view order" bar. On landscape (`tab:`
  // and up) the aside is always visible and this state is unused.
  const [cartSheetOpen, setCartSheetOpen] = React.useState(false);

  // Idempotency key regenerated after a successful placement so a rapid
  // "New Order" cannot piggyback the last one.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => cryptoRandomKey());

  // Live service-charge % from the branch config, not a hardcoded 10%.
  const [servicePct, setServicePct] = React.useState(0);
  const [taxPct, setTaxPct] = React.useState(0);
  React.useEffect(() => {
    restaurantConfig
      .get(session, branchId)
      .then((cfg) => setServicePct(Number(cfg.serviceChargePercent) || 0))
      .catch(() => undefined);
    // TenantSettings.taxRatePercent lives elsewhere; the counter shell
    // does not touch tenant settings API today. Kept at 0 unless the
    // future settings hook lands. Server always reconciles.
  }, [session, branchId]);

  // ── Draft edits ─────────────────────────────────────────────────────────
  const addOrEdit = (line: DraftLine, editingKey?: string) => {
    setDraft((rows) => {
      if (editingKey) {
        return rows.map((r) => (r.key === editingKey ? { ...line, key: editingKey } : r));
      }
      return [...rows, line];
    });
  };

  const openItem = (item: MenuItemView) => {
    if (item.modifierGroupIds.length > 0) {
      setModifierTarget({ item });
      return;
    }
    // No modifiers → straight into the cart.
    addOrEdit({
      key: cryptoRandomKey(),
      menuItemId: item.id,
      name: item.name,
      unitPrice: item.basePrice,
      quantity: 1,
      specialInstructions: '',
      modifiers: [],
    });
  };

  const editLine = (line: DraftLine) => {
    const item = findMenuItem(menuData, line.menuItemId);
    if (!item) return;
    setModifierTarget({ item, editingKey: line.key });
  };

  const changeQty = (key: string, delta: number) =>
    setDraft((rows) =>
      rows
        .map((r) => (r.key === key ? { ...r, quantity: r.quantity + delta } : r))
        .filter((r) => r.quantity > 0),
    );
  const remove = (key: string) => setDraft((r) => r.filter((row) => row.key !== key));
  const clearAll = () => {
    if (draft.length === 0) return;
    if (draft.length > 1 && !window.confirm('Clear current order? All unsent items will be removed.')) {
      return;
    }
    setDraft([]);
  };

  const applyDiscount = (key: string, discount: LineDiscount | null) => {
    setDraft((rows) =>
      rows.map((r) => (r.key === key ? { ...r, discount: discount ?? undefined } : r)),
    );
  };

  // ── Money ──────────────────────────────────────────────────────────────
  const subtotal = draftSubtotal(draft);
  const totalItemDiscount = draft.reduce((sum, l) => sum + discountAmount(l), 0);
  const netSubtotal = Math.max(0, subtotal - totalItemDiscount);
  const serviceCharge = mode === 'THIRD_PARTY' ? 0 : netSubtotal * (servicePct / 100);
  const taxAmount = (netSubtotal + serviceCharge) * (taxPct / 100);
  const total = netSubtotal + serviceCharge + taxAmount;

  // ── Stage transitions ──────────────────────────────────────────────────
  const openCustomer = () => {
    if (draft.length === 0 || !canPlaceTakeaway) return;
    // Portrait: the cart Sheet has to yield before the customer Dialog goes
    // up, otherwise both modals stack and the user cannot see whose backdrop
    // they are tapping.
    setCartSheetOpen(false);
    setStage('customer');
  };

  const customerChosen = (chosen: ChosenCustomer | null) => {
    setCustomer(chosen);
    setStage('payment');
  };

  const paymentCompleted = (result: CompletionSummary) => {
    setCompletion(result);
    setStage('completed');
    setIdempotencyKey(cryptoRandomKey());
  };

  const newOrder = () => {
    setDraft([]);
    setCustomer(null);
    setCompletion(null);
    setStage('compose');
    // Keep the mode selected — most cashiers do multiple orders of the same type.
    // If they want to switch, the Change chip is right there.
  };

  const resetMode = () => {
    if (draft.length > 0) {
      if (!window.confirm('Changing order type will clear the current cart. Continue?')) {
        return;
      }
      setDraft([]);
    }
    setMode(null);
    onModeChange(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────

  // First tap: pick a mode. No mode = the Order Type modal shows.
  if (!mode) {
    return (
      <PosOrderTypeModal
        onSelect={(m) => {
          setMode(m);
          onModeChange(m);
        }}
        onCancel={() => router.back()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="POS"
          description={`${session.branchName} · Counter 1`}
        />
        <PosModeChip mode={mode} onChange={resetMode} />
      </div>

      {/* Grid splits at `tab:` (900px) — comfortably before iPad landscape
          (1024) so we get the two-column layout on the widest tablet form
          factors. `min(400px,38%)` caps the aside so a 2560px monitor does
          not float a 400px column beside a 2000px menu; and the menu stays
          `minmax(0,1fr)` to prevent flex overflow of long item names. */}
      <div className="grid gap-4 tab:grid-cols-[minmax(0,1fr)_min(400px,38%)] xl:grid-cols-[minmax(0,1fr)_min(420px,36%)]">
        {/* Menu column adds `pb-safe-20` below `tab:` so the sticky bottom
            order bar (h≈4rem + safe-area inset) does not eat the last row of
            item cards. `tab:pb-0` restores flush spacing once the bar hides. */}
        <div className="min-w-0 pb-safe-20 tab:pb-0">
          <PosMenuBrowser data={menuData} loading={menuLoading} onPick={openItem} />
        </div>

        {/* Aside is hidden below `tab:` — cart moves to a Sheet on portrait.
            `tab:sticky tab:top-4` (previously `lg:`) means the stickiness
            kicks in at the same breakpoint the column reveals, so the cart
            never scrolls out of view once it is on screen. */}
        <aside className="hidden tab:block tab:sticky tab:top-4">
          <CartCard
            draft={draft}
            onEdit={editLine}
            onDiscount={(key) => setDiscountTargetKey(key)}
            onChangeQty={changeQty}
            onRemove={remove}
            onClearAll={clearAll}
            canDiscount={canDiscount}
            mode={mode}
            subtotal={subtotal}
            itemDiscount={totalItemDiscount}
            serviceCharge={serviceCharge}
            taxAmount={taxAmount}
            servicePct={servicePct}
            taxPct={taxPct}
            total={total}
            onPlaceOrder={openCustomer}
            canPlace={canPlaceTakeaway}
          />
        </aside>
      </div>

      {/* Portrait-only sticky bottom bar — a tap opens the cart Sheet. Hidden
          from ARIA when empty so the peek does not announce "0 items". The
          bar is `tab:hidden` and the Sheet is portrait-only, so together they
          form the portrait cart affordance without any hook-based
          orientation branching in this component. */}
      {draft.length > 0 ? (
        <div className="tab:hidden fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-safe shadow-pop">
          <button
            type="button"
            onClick={() => setCartSheetOpen(true)}
            aria-label={`View order — ${draft.reduce((s, r) => s + r.quantity, 0)} items, ${formatMoney(total)}`}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left touch-manipulation touch-target"
          >
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {draft.reduce((s, r) => s + r.quantity, 0)}{' '}
                item{draft.reduce((s, r) => s + r.quantity, 0) === 1 ? '' : 's'}
              </div>
              <div className="text-lg font-semibold tabular-nums">
                {formatMoney(total)}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              View order
              <ChevronUp className="h-4 w-4" aria-hidden />
            </div>
          </button>
        </div>
      ) : null}

      {/* Portrait cart Sheet. Same body + place-order footer the aside uses,
          composed via the Sheet's `footer` prop so Place Order stays pinned
          while the line list scrolls. */}
      <Sheet
        open={cartSheetOpen}
        onClose={() => setCartSheetOpen(false)}
        height="full"
        title="Current order"
        description={`${draft.reduce((s, r) => s + r.quantity, 0)} item${
          draft.reduce((s, r) => s + r.quantity, 0) === 1 ? '' : 's'
        } · ${formatMoney(total)}`}
        footer={
          <CartPlaceOrderFooter
            canPlace={canPlaceTakeaway}
            disabled={draft.length === 0}
            total={total}
            mode={mode}
            onPlaceOrder={openCustomer}
            fullWidth
          />
        }
      >
        <CartBody
          draft={draft}
          onEdit={editLine}
          onDiscount={(key) => setDiscountTargetKey(key)}
          onChangeQty={changeQty}
          onRemove={remove}
          onClearAll={clearAll}
          canDiscount={canDiscount}
          subtotal={subtotal}
          itemDiscount={totalItemDiscount}
          serviceCharge={serviceCharge}
          taxAmount={taxAmount}
          servicePct={servicePct}
          taxPct={taxPct}
          total={total}
        />
      </Sheet>

      {modifierTarget ? (
        <ModifierPickerDialog
          item={modifierTarget.item}
          groupsById={menuData.modifierGroupsById}
          initialLine={
            modifierTarget.editingKey
              ? draft.find((r) => r.key === modifierTarget.editingKey) ?? null
              : null
          }
          onCancel={() => setModifierTarget(null)}
          onConfirm={(lines) => {
            const line = lines[0];
            if (line) addOrEdit(line, modifierTarget.editingKey);
            setModifierTarget(null);
          }}
        />
      ) : null}

      {discountTargetKey ? (
        <ItemDiscountDialog
          line={draft.find((r) => r.key === discountTargetKey)!}
          roleLimit={discountLimit}
          onApply={(discount) => {
            applyDiscount(discountTargetKey, discount);
            setDiscountTargetKey(null);
          }}
          onClose={() => setDiscountTargetKey(null)}
        />
      ) : null}

      {stage === 'customer' ? (
        <CustomerCapturePopup
          session={session}
          mode={mode}
          onChoose={customerChosen}
          onBack={() => setStage('compose')}
        />
      ) : null}

      {stage === 'payment' ? (
        <PaymentPopup
          session={session}
          branchId={branchId}
          mode={mode}
          customer={customer}
          draft={draft}
          idempotencyKey={idempotencyKey}
          computedTotals={{ subtotal: netSubtotal, serviceCharge, taxAmount, total }}
          onBack={() => setStage('customer')}
          onCompleted={paymentCompleted}
        />
      ) : null}

      {stage === 'completed' && completion ? (
        <OrderCompletionScreen
          summary={completion}
          onNewOrder={newOrder}
          onViewOrder={() => router.push('/orders')}
        />
      ) : null}
    </div>
  );
}

// ── Cart Card ───────────────────────────────────────────────────────────
//
// Two shells now share the cart body:
//   * `<CartCard>` — the framed rail rendered in the desktop / landscape
//     aside. Owns its own scroll region and the Place Order button lives at
//     the bottom of the card.
//   * `<Sheet>` (rendered in the workspace) — wraps `<CartBody>` on portrait
//     and pins `<CartPlaceOrderFooter>` via the Sheet's `footer` prop.
//
// Both shells render the same `<CartBody>` and `<CartPlaceOrderFooter>` so
// the two surfaces cannot drift.

interface CartRailBodyProps {
  draft: DraftLine[];
  onEdit: (line: DraftLine) => void;
  onDiscount: (key: string) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onClearAll: () => void;
  canDiscount: boolean;
  subtotal: number;
  itemDiscount: number;
  serviceCharge: number;
  taxAmount: number;
  servicePct: number;
  taxPct: number;
  total: number;
}

interface CartCardProps extends CartRailBodyProps {
  mode: PosMode;
  onPlaceOrder: () => void;
  canPlace: boolean;
}

function CartCard(props: CartCardProps) {
  const {
    mode, total, onPlaceOrder, canPlace, ...body
  } = props;

  return (
    <div className="flex max-h-[calc(100vh-9rem)] flex-col rounded-xl border border-border bg-surface shadow-sm">
      <CartBody {...body} total={total} />
      <div className="border-t border-border p-3">
        <CartPlaceOrderFooter
          canPlace={canPlace}
          disabled={body.draft.length === 0}
          total={total}
          mode={mode}
          onPlaceOrder={onPlaceOrder}
          fullWidth
        />
      </div>
    </div>
  );
}

function CartBody(props: CartRailBodyProps) {
  const {
    draft, onEdit, onDiscount, onChangeQty, onRemove, onClearAll,
    canDiscount, subtotal, itemDiscount, serviceCharge, taxAmount,
    servicePct, taxPct, total,
  } = props;

  return (
    // `min-h-0` + `flex-1` on the scroll region keeps the running-bill
    // summary anchored when this body renders inside either the card OR the
    // Sheet's scroll container.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Current order</span>
          {draft.length > 0 ? (
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-primary">
              {draft.reduce((s, r) => s + r.quantity, 0)} items
            </span>
          ) : null}
        </div>
        {draft.length > 0 ? (
          <button
            type="button"
            onClick={onClearAll}
            className="text-xs text-danger hover:underline"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {draft.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
            <ShoppingCart className="mb-2 h-8 w-8 opacity-40" />
            No items yet.
            <br />
            Select an item from the menu to start the order.
          </div>
        ) : (
          draft.map((line) => (
            <CartLineRow
              key={line.key}
              line={line}
              onEdit={() => onEdit(line)}
              onDiscount={() => onDiscount(line.key)}
              onChangeQty={(d) => onChangeQty(line.key, d)}
              onRemove={() => onRemove(line.key)}
              canDiscount={canDiscount}
            />
          ))
        )}
      </div>

      <RunningBillSummary
        itemCount={draft.reduce((s, r) => s + r.quantity, 0)}
        subtotal={subtotal}
        itemDiscount={itemDiscount}
        serviceCharge={serviceCharge}
        taxAmount={taxAmount}
        servicePct={servicePct}
        taxPct={taxPct}
        total={total}
      />
    </div>
  );
}

function CartPlaceOrderFooter({
  canPlace,
  disabled,
  total,
  mode,
  onPlaceOrder,
  fullWidth,
}: {
  canPlace: boolean;
  disabled: boolean;
  total: number;
  mode: PosMode;
  onPlaceOrder: () => void;
  fullWidth?: boolean;
}) {
  return (
    // `w-full` inside a `flex-wrap` Sheet footer keeps the CTA edge-to-edge on
    // portrait; the card shell also passes `fullWidth`. The button stays 56px
    // (`h-14`) which is the primary-action height throughout the counter.
    <div className={fullWidth ? 'w-full' : undefined}>
      <button
        type="button"
        onClick={onPlaceOrder}
        disabled={disabled || !canPlace}
        className="flex h-14 w-full items-center justify-between rounded-xl bg-primary px-5 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover active:bg-primary-active touch-manipulation disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>Place Order</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </button>
      {!canPlace ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          Your role can build a draft but not place a counter order.
        </p>
      ) : null}
      {mode === 'THIRD_PARTY' ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <ReceiptText className="h-3.5 w-3.5" />
          Delivery orders skip immediate payment — collected on delivery.
        </p>
      ) : null}
    </div>
  );
}

// ── Cart line ───────────────────────────────────────────────────────────

function CartLineRow({
  line,
  onEdit,
  onDiscount,
  onChangeQty,
  onRemove,
  canDiscount,
}: {
  line: DraftLine;
  onEdit: () => void;
  onDiscount: () => void;
  onChangeQty: (delta: number) => void;
  onRemove: () => void;
  canDiscount: boolean;
}) {
  const unitWithMods =
    Number(line.unitPrice) + line.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0);
  const lineSubtotal = line.quantity * unitWithMods;
  const discAmount = discountAmount(line);
  const lineTotal = Math.max(0, lineSubtotal - discAmount);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{line.name}</p>
            <p className="text-sm font-semibold tabular-nums">
              {formatMoney(lineTotal)}
            </p>
          </div>
          {line.modifiers.length > 0 ? (
            <ul className="mt-0.5 text-xs text-muted-foreground">
              {line.modifiers.map((m) => (
                <li key={m.optionId}>
                  + {m.optionName}
                  {Number(m.priceDelta) !== 0 ? ` (${formatMoney(m.priceDelta)})` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {line.specialInstructions ? (
            <p className="mt-1 rounded bg-muted/50 px-2 py-1 text-xs italic text-muted-foreground">
              Note: {line.specialInstructions}
            </p>
          ) : null}
          {line.discount ? (
            <p className="mt-1 flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1 text-success">
                <Percent className="h-3 w-3" />
                {discountLabel(line.discount)}
              </span>
              <span className="tabular-nums text-success">- {formatMoney(discAmount)}</span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1">
          <QtyBtn onClick={() => onChangeQty(-1)} aria-label="Decrease quantity">
            −
          </QtyBtn>
          <span className="min-w-6 text-center text-sm font-semibold">{line.quantity}</span>
          <QtyBtn onClick={() => onChangeQty(1)} aria-label="Increase quantity">
            +
          </QtyBtn>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-brand-100"
          >
            Edit
          </button>
          {canDiscount ? (
            <button
              type="button"
              onClick={onDiscount}
              className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-brand-100"
            >
              Discount
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove item"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function QtyBtn({
  children,
  onClick,
  ...aria
}: {
  children: React.ReactNode;
  onClick: () => void;
  'aria-label': string;
}) {
  return (
    // 32px base to preserve the compact cart line, promoted to 44px on
    // coarse pointers via `touch-target-coarse` so a fingertip never lands
    // ambiguously between +/−.
    <button
      type="button"
      onClick={onClick}
      {...aria}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-base font-medium text-foreground hover:bg-muted active:scale-95 touch-target-coarse touch-manipulation"
    >
      {children}
    </button>
  );
}

// ── Money helpers ───────────────────────────────────────────────────────

function discountAmount(line: DraftLine): number {
  if (!line.discount) return 0;
  const unitWithMods =
    Number(line.unitPrice) + line.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0);
  const lineSubtotal = line.quantity * unitWithMods;
  if (line.discount.type === 'PERCENTAGE') {
    return round2(lineSubtotal * (line.discount.value / 100));
  }
  return Math.min(lineSubtotal, round2(line.discount.value));
}

function discountLabel(discount: LineDiscount): string {
  if (discount.type === 'PERCENTAGE') return `${discount.value}% off`;
  return `Fixed ${formatMoney(discount.value)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function findMenuItem(
  data: ReturnType<typeof useMenuData>['data'],
  id: string,
): MenuItemView | null {
  for (const list of data.itemsBySection.values()) {
    const hit = list.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

// Silence lints for imports that live below the cutoff — they are used inside
// the child components imported at the top of the file.
void ApiError;
void takeaway;
void withinDiscountLimit;
