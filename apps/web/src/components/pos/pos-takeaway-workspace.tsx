'use client';

import { Send, ShoppingBag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { restaurantConfig, takeaway } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView } from '@/lib/restaurant/types';

import { ModifierPickerDialog } from './modifier-picker-dialog';
import { PosCart } from './pos-cart';
import { PosMenuBrowser } from './pos-menu-browser';
import { PosShell } from './pos-shell';
import type { DraftLine } from './pos-types';
import { cryptoRandomKey, draftSubtotal } from './pos-utils';
import { useMenuData } from './use-menu-data';

interface Props {
  session: Session;
  branchId: string;
}

/**
 * POS Takeaway mode — the new order-composition workspace that replaces
 * the form-driven /takeaway/new page.
 *
 * Ownership:
 *   - Draft is local React state only until Place Order (PO decision 6:
 *     no server-side takeaway draft entity today; browser refresh throws
 *     the draft away, which is safer than a half-persisted order).
 *   - Server is authoritative for the frozen unit price, service charge
 *     percent (read from RestaurantBranchConfig) and total. The subtotal
 *     shown here is a snapshot for the operator's benefit only.
 *   - Idempotency key is generated once per draft session and re-issued
 *     after a successful place — so a double-tap on Place Order cannot
 *     open two orders on the same key, and a hard error keeps the same
 *     key so a retry lands on the same row.
 */
export function PosTakeawayWorkspace({ session, branchId }: Props) {
  const router = useRouter();
  const { hasPermission } = useAuth();
  // Takeaway create requires TAKEAWAY_CREATE — enforced server-side, mirrored
  // here to disable the CTA when the caller cannot proceed.
  const canPlace = hasPermission(Permission.TAKEAWAY_CREATE);

  const { data: menuData, loading, error } = useMenuData(session, branchId);

  const [draft, setDraft] = React.useState<DraftLine[]>([]);
  const [modifierTarget, setModifierTarget] = React.useState<MenuItemView | null>(null);
  const [customerName, setCustomerName] = React.useState('');
  const [customerPhone, setCustomerPhone] = React.useState('');
  const [pickupAt, setPickupAt] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const [sending, setSending] = React.useState(false);
  const [placeError, setPlaceError] = React.useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => cryptoRandomKey());

  // Live service-charge percent so the totals reflect the tenant's real
  // configuration rather than an assumed 10%.
  const [servicePct, setServicePct] = React.useState<number>(0);
  React.useEffect(() => {
    let cancelled = false;
    restaurantConfig
      .get(session, branchId)
      .then((cfg) => {
        if (!cancelled) setServicePct(Number(cfg.serviceChargePercent) || 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const addItem = (item: MenuItemView) => {
    if (item.modifierGroupIds.length > 0) {
      setModifierTarget(item);
      return;
    }
    setDraft((rows) => [
      ...rows,
      {
        key: cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.basePrice,
        quantity: 1,
        specialInstructions: '',
        modifiers: [],
      },
    ]);
  };

  const changeQty = (key: string, delta: number) =>
    setDraft((rows) =>
      rows
        .map((r) => (r.key === key ? { ...r, quantity: r.quantity + delta } : r))
        .filter((r) => r.quantity > 0),
    );
  const remove = (key: string) => setDraft((rows) => rows.filter((r) => r.key !== key));
  const setInstructions = (key: string, val: string) =>
    setDraft((rows) =>
      rows.map((r) => (r.key === key ? { ...r, specialInstructions: val } : r)),
    );

  const subtotal = draftSubtotal(draft);
  const serviceCharge = subtotal * (servicePct / 100);
  const total = subtotal + serviceCharge;

  const place = async () => {
    if (draft.length === 0) return;
    setSending(true);
    setPlaceError(null);
    try {
      const created = await takeaway.create(session, {
        branchId,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        pickupAt: pickupAt ? new Date(pickupAt).toISOString() : undefined,
        notes: notes.trim() || undefined,
        idempotencyKey,
        items: draft.map((r) => ({
          menuItemId: r.menuItemId,
          quantity: r.quantity,
          specialInstructions: r.specialInstructions.trim() || undefined,
          modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
        })),
      });
      // Fresh idempotency key so the operator's next draft can't collide
      // with the one just placed.
      setIdempotencyKey(cryptoRandomKey());
      setDraft([]);
      setCustomerName('');
      setCustomerPhone('');
      setPickupAt('');
      setNotes('');
      router.push(`/orders?just=${encodeURIComponent(created.orderNumber)}`);
    } catch (err) {
      // Same idempotency key preserved so a network retry lands on the
      // same server row rather than creating a duplicate.
      setPlaceError(err instanceof Error ? err.message : 'Failed to place order');
      setSending(false);
    }
  };

  const rail = (
    <Card className="flex max-h-[calc(100vh-9rem)] flex-col">
      <CardHeader className="flex-row items-start gap-2">
        <div className="mt-1 rounded-md bg-brand-100 p-1.5 text-primary">
          <ShoppingBag className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base">Takeaway</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Draft — not placed. Server owns totals and receipts.
          </p>
        </div>
        <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {draft.reduce((s, r) => s + r.quantity, 0)}{' '}
          {draft.reduce((s, r) => s + r.quantity, 0) === 1 ? 'item' : 'items'}
        </span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-y-auto">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="cust-name">
            Customer
          </label>
          <Input
            id="cust-name"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Walk-in — leave blank if unknown"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cust-phone">
              Phone
            </label>
            <Input
              id="cust-phone"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="+94 77…"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cust-pickup">
              Pickup
            </label>
            <Input
              id="cust-pickup"
              type="datetime-local"
              value={pickupAt}
              onChange={(e) => setPickupAt(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="cust-note">
            Order note
          </label>
          <textarea
            id="cust-note"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. no chilli"
            rows={2}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
        </div>

        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Order items
          </p>
          <PosCart
            draft={draft}
            onChangeQty={changeQty}
            onRemove={remove}
            onInstructions={setInstructions}
            emptyMessage="Tap items on the left to build the order."
          />
        </div>

        {draft.length > 0 ? (
          <div className="space-y-1.5 border-t border-border pt-3 text-sm">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatMoney(subtotal)}</span>
            </div>
            {servicePct > 0 ? (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Service charge ({servicePct}%)</span>
                <span>{formatMoney(serviceCharge)}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between border-t border-dashed border-border pt-2 text-base font-semibold">
              <span>Total</span>
              <span>{formatMoney(total)}</span>
            </div>
          </div>
        ) : null}
      </CardContent>
      <div className="space-y-2 border-t border-border p-4">
        {placeError ? (
          <p className="text-sm text-danger">{placeError}</p>
        ) : null}
        <Button
          fullWidth
          size="lg"
          leftIcon={<Send className="h-4 w-4" />}
          onClick={place}
          isLoading={sending}
          disabled={draft.length === 0 || !canPlace}
        >
          Place Order
        </Button>
        {!canPlace ? (
          <p className="text-xs text-muted-foreground">
            Your role can build a draft but not place a takeaway order.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            fullWidth
            disabled
            title="Server-side takeaway drafts are deferred — the draft here is local only."
          >
            Save Draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            fullWidth
            disabled={draft.length === 0}
            onClick={() => {
              setDraft([]);
              setPlaceError(null);
            }}
          >
            Clear
          </Button>
        </div>
      </div>
    </Card>
  );

  const workspace = (
    <>
      <PosMenuBrowser data={menuData} loading={loading} onPick={addItem} />
      {error ? (
        <p className="mt-2 text-sm text-danger">{error}</p>
      ) : null}
    </>
  );

  return (
    <>
      <PosShell
        mode="TAKEAWAY"
        onModeChange={(next) => {
          // In this slice only Takeaway is wired; Dine-In + 3rd Party
          // ship in Slice C. Non-Takeaway clicks bounce to /pos with the
          // new mode as a query param so the router history stays clean.
          router.push(`/pos?mode=${next.toLowerCase()}`);
        }}
        branchName="Main Dining"
        registerName="Counter 1"
        workspace={workspace}
        rail={rail}
      />
      {modifierTarget ? (
        <ModifierPickerDialog
          item={modifierTarget}
          groupsById={menuData.modifierGroupsById}
          onCancel={() => setModifierTarget(null)}
          onConfirm={(lines) => {
            setDraft((rows) => [...rows, ...lines]);
            setModifierTarget(null);
          }}
        />
      ) : null}
    </>
  );
}
