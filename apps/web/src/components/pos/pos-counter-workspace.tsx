'use client';

import { AlertTriangle, ChevronUp, Percent, ReceiptText, ShoppingCart, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { Sheet } from '@/components/ui/sheet';
import { ApiError } from '@/lib/api';
import { useAuth, type Session } from '@/lib/auth';
import { discountLimitFor, withinDiscountLimit, Permission } from '@/lib/permissions';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { restaurantConfig, tableSessions, takeaway } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView } from '@/lib/restaurant/types';

import { CustomerCapturePopup, type ChosenCustomer } from './counter/customer-capture-popup';
import { TableBillSheet } from './dine-in/table-bill-sheet';
import { TableSessionPanel, type ActiveTableSession } from './dine-in/table-session-panel';
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
import { addDraftLine, cryptoRandomKey, draftSubtotal } from './pos-utils';
import { useMenuData, usePosCatalogue } from './use-menu-data';

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
  /*
   * D69 — dine-in is gated on a DIFFERENT permission, and it matters: the
   * WAITER template deliberately holds ORDER_SEND_TO_KITCHEN and not
   * TAKEAWAY_CREATE. Reusing the counter's gate here would have left the
   * one role this flow exists for looking at a disabled button.
   */
  const canSendToKitchen = hasPermission(Permission.ORDER_SEND_TO_KITCHEN);
  /*
   * D71 — the waiter divides the bill because the waiter is the one the
   * guests are talking to. BILL_SPLIT allocates shares; it does not take
   * money, so a role can split four ways and still not settle any of them.
   */
  const canSplitBill = hasPermission(Permission.BILL_SPLIT);
  const canDiscount = hasPermission(Permission.DISCOUNT_APPROVE);
  const discountLimit = discountLimitFor(session.user.role);

  const [mode, setMode] = React.useState<PosMode | null>(initialMode);

  // ── D69: dine-in session state ─────────────────────────────────────────
  const [tableSession, setTableSession] = React.useState<ActiveTableSession | null>(null);
  const [roundsSent, setRoundsSent] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [dineInError, setDineInError] = React.useState<string | null>(null);
  /** D71 — the bill sheet: review, split, close. */
  const [billOpen, setBillOpen] = React.useState(false);
  const [closedBill, setClosedBill] = React.useState<{
    saleId: string;
    table: string;
    splitCount: number;
  } | null>(null);

  // D45: Restaurant / Cafe / Bakery tenants read the new POS catalogue
  // endpoint (Products the wizard published as POS-sellable). Retail
  // tenants never reach this workspace (they render `PosRetailCheckout`),
  // so the fallback to the legacy admin-menu chain is defensive rather
  // than load-bearing — it keeps the workspace usable if a tenant with an
  // unresolved profile lands here before the profile has loaded.
  const { profile } = useEffectiveProfile();
  // D56: a capability read, not a business-type comparison. The inline
  // predicate this replaced omitted HOTEL in every copy of itself — the
  // capability is resolved once, server-side, from the domain registry.
  const isRestaurantProfile = profile?.capabilities.fulfilment.kind === 'TABLE_SERVICE';

  // Both hooks always run — React requires stable hook order. The unused
  // branch resolves to EMPTY_MENU without a network round-trip because the
  // hook short-circuits when the branch selector below picks the other.
  // We gate by nulling `branchId` on the inactive hook so it never fetches.
  const catalogueChannel =
    mode === 'DINE_IN' ? 'DINE_IN' : mode === 'THIRD_PARTY' ? 'ONLINE' : 'TAKEAWAY';
  const catalogue = usePosCatalogue(
    session,
    isRestaurantProfile ? branchId : null,
    catalogueChannel,
  );
  const legacyMenu = useMenuData(session, isRestaurantProfile ? null : branchId);
  const { data: menuData, loading: menuLoading } = isRestaurantProfile ? catalogue : legacyMenu;

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
        // Edits REPLACE in place, never merge: an operator adjusting a line
        // expects it to stay where it is, and a mid-edit merge into another
        // row would silently move (and re-count) what they are looking at.
        return rows.map((r) => (r.key === editingKey ? { ...line, key: editingKey } : r));
      }
      // Adds merge into an identical existing line (2026-08-18): same
      // product AND variant, same modifier set, same instructions, and no
      // line discount involved — see draftLineMergeKey for the exact rule.
      return addDraftLine(rows, line);
    });
  };

  const openItem = (item: MenuItemView) => {
    // D46 — variants force the Customise dialog too. Even with zero
    // modifier groups a Product with variants must let the operator pick
    // the size, so the fast-add short-circuit only applies when BOTH
    // lists are empty.
    const hasVariants = (item.variants ?? []).length > 0;
    if (item.modifierGroupIds.length > 0 || hasVariants) {
      setModifierTarget({ item });
      return;
    }
    // No modifiers, no variants → straight into the cart. Source
    // discriminator carries over so the submit call site can route to
    // the PRODUCT wire shape (D46).
    const isProductSource = item.catalogueSource === 'PRODUCT';
    addOrEdit({
      key: cryptoRandomKey(),
      menuItemId: item.id,
      name: item.name,
      unitPrice: item.basePrice,
      quantity: 1,
      specialInstructions: '',
      modifiers: [],
      sourceKind: isProductSource ? 'PRODUCT' : 'MENU_ITEM',
      ...(isProductSource ? { productId: item.id } : {}),
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

  // ── D69: dine-in actions ───────────────────────────────────────────────

  /**
   * Confirm the current cart onto the table's order as one round.
   *
   * This is where dine-in stops resembling a counter sale: no customer
   * capture, no payment, no completion screen. The round is sent, the cart
   * empties, and the waiter is immediately able to take the next thing the
   * table asks for — which is the actual shape of table service.
   */
  const sendRound = async () => {
    if (draft.length === 0 || !tableSession || !canSendToKitchen) return;
    setCartSheetOpen(false);
    setSending(true);
    setDineInError(null);
    try {
      // Opening a session does not create an order (D1); the first send is
      // what needs one, so it is created lazily here and remembered.
      let orderId = tableSession.orderId;
      if (!orderId) {
        const order = await tableSessions.createOrder(session, tableSession.id);
        orderId = order.id;
        setTableSession((cur) => (cur ? { ...cur, orderId: order.id } : cur));
      }
      await tableSessions.submitRound(session, orderId, {
        idempotencyKey,
        channel: 'DINE_IN',
        // D46 — PRODUCT-sourced lines carry their own wire shape (the server
        // resolves the variant and snapshots price/name); legacy MENU_ITEM
        // lines keep the historic shape byte-for-byte.
        items: draft.map((r) =>
          r.sourceKind === 'PRODUCT'
            ? {
                sourceKind: 'PRODUCT' as const,
                productId: r.productId!,
                productVariantId: r.productVariantId,
                quantity: r.quantity,
                specialInstructions: r.specialInstructions.trim() || undefined,
                modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
              }
            : {
                menuItemId: r.menuItemId,
                quantity: r.quantity,
                specialInstructions: r.specialInstructions.trim() || undefined,
                modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
              },
        ),
      });
      setDraft([]);
      setRoundsSent((n) => n + 1);
      // A fresh key per round: the same one twice would make the second
      // round a replay of the first and silently drop it.
      setIdempotencyKey(cryptoRandomKey());
    } catch (err) {
      setDineInError(err instanceof Error ? err.message : 'Could not send to the kitchen');
    } finally {
      setSending(false);
    }
  };

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
    setTableSession(null);
    setRoundsSent(0);
    setClosedBill(null);
    setMode(null);
    onModeChange(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────

  /*
   * D69 — one screen, two tails. Dine-in composes exactly like a counter
   * order and then diverges at the button: it sends a round to a table
   * instead of opening the customer → payment → completion chain.
   */
  const isDineIn = mode === 'DINE_IN';
  const placeOrder = isDineIn ? () => void sendRound() : openCustomer;
  const canPlace = isDineIn ? canSendToKitchen && tableSession !== null : canPlaceTakeaway;

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

      {/* D69 — dine-in's one structural difference from a counter order: the
          order belongs to a table, over a period. Rendered above the grid so
          it reads first and stays put; picking a table swaps it for a strip
          rather than navigating, so the menu never unmounts mid-order. */}
      {isDineIn ? (
        <>
          <TableSessionPanel
            session={session}
            branchId={branchId}
            active={tableSession}
            onPick={(picked) => {
              setTableSession(picked);
              setRoundsSent(0);
              setClosedBill(null);
              setDineInError(null);
            }}
            onOpenBill={() => setBillOpen(true)}
            roundsSent={roundsSent}
          />
          {dineInError ? (
            <p className="flex items-center gap-1.5 text-sm text-danger">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {dineInError}
            </p>
          ) : null}
          {closedBill ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success/40 bg-success-soft/50 p-3 text-sm">
              <span>
                {closedBill.table} closed
                {closedBill.splitCount > 1
                  ? ` into ${closedBill.splitCount} bills`
                  : ''}
                . Ready for the cashier to settle and print.
              </span>
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => router.push(`/bills/${closedBill.saleId}`)}
              >
                View bill
              </button>
            </div>
          ) : null}
        </>
      ) : null}

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
            onPlaceOrder={placeOrder}
            canPlace={canPlace}
            sending={sending}
            awaitingTable={isDineIn && tableSession === null}
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
            canPlace={canPlace}
            disabled={draft.length === 0}
            total={total}
            mode={mode}
            onPlaceOrder={placeOrder}
            sending={sending}
            awaitingTable={isDineIn && tableSession === null}
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

      {/* D71 — the waiter's bill: the full order, the real totals, and the
          split, without leaving the screen they take orders on. */}
      {isDineIn && billOpen && tableSession ? (
        <TableBillSheet
          session={session}
          sessionId={tableSession.id}
          tableLabel={tableSession.tableLabel}
          hasUnsentDraft={draft.length > 0}
          canSplit={canSplitBill}
          onClose={() => setBillOpen(false)}
          onClosed={({ saleId, splitCount, warning }) => {
            setBillOpen(false);
            setClosedBill({ saleId, table: tableSession.tableLabel, splitCount });
            setDineInError(warning ?? null);
            setTableSession(null);
            setRoundsSent(0);
            setDraft([]);
            setIdempotencyKey(cryptoRandomKey());
          }}
        />
      ) : null}

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
  sending: boolean;
  awaitingTable: boolean;
}

function CartCard(props: CartCardProps) {
  const {
    mode, total, onPlaceOrder, canPlace, sending, awaitingTable, ...body
  } = props;

  return (
    <div className="flex max-h-[calc(100vh-9rem)] flex-col rounded-xl border border-border bg-surface shadow-sm">
      <CartBody {...body} total={total} />
      <div className="border-t border-border p-3">
        <CartPlaceOrderFooter
          canPlace={canPlace}
          sending={sending}
          awaitingTable={awaitingTable}
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
  sending,
  awaitingTable,
  fullWidth,
}: {
  canPlace: boolean;
  disabled: boolean;
  total: number;
  mode: PosMode;
  onPlaceOrder: () => void;
  sending: boolean;
  awaitingTable: boolean;
  fullWidth?: boolean;
}) {
  const isDineIn = mode === 'DINE_IN';
  return (
    // `w-full` inside a `flex-wrap` Sheet footer keeps the CTA edge-to-edge on
    // portrait; the card shell also passes `fullWidth`. The button stays 56px
    // (`h-14`) which is the primary-action height throughout the counter.
    <div className={fullWidth ? 'w-full' : undefined}>
      <button
        type="button"
        onClick={onPlaceOrder}
        disabled={disabled || !canPlace || sending}
        className="flex h-14 w-full items-center justify-between rounded-xl bg-primary px-5 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover active:bg-primary-active touch-manipulation disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* D69 — dine-in confirms a ROUND onto a table; it does not place and
            settle an order, and the button must not claim otherwise. */}
        <span>{isDineIn ? (sending ? 'Sending…' : 'Confirm & send') : 'Place Order'}</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </button>
      {awaitingTable ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          Pick a table above before sending this order.
        </p>
      ) : !canPlace ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          {isDineIn
            ? 'Your role can build a draft but not send it to the kitchen.'
            : 'Your role can build a draft but not place a counter order.'}
        </p>
      ) : null}
      {isDineIn ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <ReceiptText className="h-3.5 w-3.5" />
          Goes straight to the kitchen board. The bill is raised when you close the
          session.
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
          {/* D46 — variant name renders as a sub-line beneath the item
              name with the ABSOLUTE variant price on the right. Never
              hidden: the brief calls this out explicitly because the
              variant is often the difference between a `Small` and a
              `Large` on the same product card. */}
          {line.variantName ? (
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>{line.variantName}</span>
              {line.variantPrice ? (
                <span className="tabular-nums">
                  {formatMoney(line.variantPrice)}
                </span>
              ) : null}
            </div>
          ) : null}
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
