'use client';

import { Link2, Minus, Plus, Receipt, Send, Trash2, Unlink, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { ModifierPickerDialog } from '@/components/pos/modifier-picker-dialog';
import { type DraftLine } from '@/components/pos/pos-types';
import { addDraftLine, cryptoRandomKey } from '@/components/pos/pos-utils';
import { usePosCatalogue } from '@/components/pos/use-menu-data';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  modifierGroups as modifierGroupsApi,
  openTables,
  tableSessions,
} from '@/lib/restaurant/api';
import {
  ORDER_ITEM_STATUS_LABELS,
  ROUND_STATUS_LABELS,
  ROUND_STATUS_TONES,
  formatElapsed,
  formatMoney,
  formatTime,
} from '@/lib/restaurant/labels';
import type {
  MenuItemView,
  ModifierGroupView,
  OpenTableReleaseSummary,
  OrderView,
  RoundView,
  SectionView,
  SessionDetail,
  SessionDetailItem,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  sessionId: string;
}

// DraftLine, MenuData, EMPTY_MENU moved to components/pos/pos-types.ts and are
// imported above. Dine-in behaviour is unchanged — the same shapes travel
// through the same call sites; only the declaration site moved so the POS
// workspace can share them.

export function OrderEntry({ session, sessionId }: Props) {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canSend = hasPermission(Permission.ORDER_SEND_TO_KITCHEN);
  const canVoid = hasPermission(Permission.ORDER_VOID_SENT);
  const canClose = hasPermission(Permission.TABLE_CLOSE);
  // D50 — closing a shared arrangement may leave tables reserved by another
  // party; the operator is reminded and can release them inline.
  const canManageOpenTables = hasPermission(Permission.OPEN_TABLE_MANAGE);
  const [releaseReminder, setReleaseReminder] = React.useState<{
    saleId: string;
    stillReserved: OpenTableReleaseSummary['stillReserved'];
  } | null>(null);
  const [closingBill, setClosingBill] = React.useState(false);
  const [closeError, setCloseError] = React.useState<string | null>(null);
  const [closeKey] = React.useState(() => cryptoRandomKey());
  const [showCloseConfirm, setShowCloseConfirm] = React.useState(false);

  const [detail, setDetail] = React.useState<SessionDetail | null>(null);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedMenuId, setSelectedMenuId] = React.useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);

  const [draft, setDraft] = React.useState<DraftLine[]>([]);
  const [modifierTarget, setModifierTarget] = React.useState<MenuItemView | null>(null);
  const [voidTarget, setVoidTarget] = React.useState<SessionDetailItem | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  // Fresh idempotency key per Send-attempt session. Re-generated after a
  // completed round or a hard error, never re-used for a retry.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => cryptoRandomKey());

  const branchId = detail?.session.branchId ?? null;

  /*
   * 2026-08-18 — the waiter picks from the SAME catalogue the counter POS
   * shows (`GET /products/sellable` via the POS-catalogue adapter), not the
   * frozen legacy menu tree this screen used to read. Menu authoring moved
   * to Products in D45/D60: a waiter reading `menus → sections → items` saw
   * whatever legacy rows happened to survive the convergence, which on a
   * fresh workspace is nothing at all.
   */
  const { data: menuData } = usePosCatalogue(session, branchId, 'DINE_IN');

  const load = React.useCallback(async () => {
    try {
      const fetched = await tableSessions.getDetail(session, sessionId);
      setDetail(fetched);
      setLoadState('ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load session');
      setLoadState('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Once we know the branch, poll gently for round-status changes so the
  // waiter sees "Ready" without a manual refresh. 8 s cadence: fast enough to
  // notice a kitchen update between glances, slow enough to keep tablet load
  // low.
  React.useEffect(() => {
    if (loadState !== 'ready') return;
    const t = setInterval(() => {
      void tableSessions
        .getDetail(session, sessionId)
        .then(setDetail)
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(t);
  }, [loadState, session, sessionId]);

  // Default the chips to the first menu/section once the catalogue lands, so
  // the grid never starts empty.
  React.useEffect(() => {
    const first = menuData.menus[0];
    if (!first) return;
    setSelectedMenuId((current) => current ?? first.id);
    const firstSection = menuData.sectionsByMenu.get(first.id)?.[0];
    if (firstSection) setSelectedSectionId((current) => current ?? firstSection.id);
  }, [menuData]);

  const currentSections =
    selectedMenuId ? menuData.sectionsByMenu.get(selectedMenuId) ?? [] : [];
  const currentItems =
    selectedSectionId ? menuData.itemsBySection.get(selectedSectionId) ?? [] : [];

  // ── Draft edits ────────────────────────────────────────────────────────
  const addSimpleItem = (item: MenuItemView) => {
    // D46 — a Product with variants must open the customise dialog even with
    // no modifier groups, or the waiter cannot choose the size.
    const hasVariants = (item.variants ?? []).length > 0;
    if (item.modifierGroupIds.length > 0 || hasVariants) {
      setModifierTarget(item);
      return;
    }
    const isProductSource = item.catalogueSource === 'PRODUCT';
    // Merges into an identical existing line instead of stacking duplicate
    // rows (2026-08-18) — see draftLineMergeKey for the exact identity rule.
    setDraft((rows) =>
      addDraftLine(rows, {
        key: cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.basePrice,
        quantity: 1,
        specialInstructions: '',
        modifiers: [],
        sourceKind: isProductSource ? 'PRODUCT' : 'MENU_ITEM',
        ...(isProductSource ? { productId: item.id } : {}),
      }),
    );
  };

  const changeQty = (key: string, delta: number) => {
    setDraft((rows) =>
      rows
        .map((r) => (r.key === key ? { ...r, quantity: r.quantity + delta } : r))
        .filter((r) => r.quantity > 0),
    );
  };

  const removeLine = (key: string) => {
    setDraft((rows) => rows.filter((r) => r.key !== key));
  };

  const setInstructions = (key: string, value: string) => {
    setDraft((rows) => rows.map((r) => (r.key === key ? { ...r, specialInstructions: value } : r)));
  };

  const draftSubtotal = draft.reduce((sum, r) => {
    const unit = Number(r.unitPrice);
    const mods = r.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0);
    return sum + r.quantity * (unit + mods);
  }, 0);

  // ── Send round ─────────────────────────────────────────────────────────
  const send = async () => {
    if (draft.length === 0 || !detail) return;
    setSending(true);
    setSendError(null);
    try {
      // Ensure there is an order (D1). Backend session open does not create
      // an order automatically; we lazily open one on the first send.
      let orderId = firstActiveOrderId(detail);
      if (!orderId) {
        const order = await tableSessions.createOrder(session, sessionId);
        orderId = order.id;
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
      setIdempotencyKey(cryptoRandomKey());
      await load();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send round');
    } finally {
      setSending(false);
    }
  };

  // ── Void an already-sent item ──────────────────────────────────────────
  const voidItem = async (reason: string) => {
    if (!voidTarget) return;
    await tableSessions.voidItem(session, voidTarget.id, { reason });
    setVoidTarget(null);
    await load();
  };

  // ── Close session and route to the bill ────────────────────────────────
  const closeAndBill = async () => {
    setClosingBill(true);
    setCloseError(null);
    try {
      const { saleId, openTableRelease } = await tableSessions.close(session, sessionId, {
        idempotencyKey: closeKey,
      });
      // D50: when this was an open table sharing physical tables with another
      // party, the server released only what it could prove was free. Stop
      // before the bill and ask about the rest — the floor knows, the server
      // cannot.
      if (openTableRelease && openTableRelease.stillReserved.length > 0 && branchId) {
        setShowCloseConfirm(false);
        setReleaseReminder({ saleId, stillReserved: openTableRelease.stillReserved });
        setClosingBill(false);
        return;
      }
      router.push(`/bills/${saleId}`);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Failed to close session');
      setClosingBill(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading order…
        </CardContent>
      </Card>
    );
  }
  if (loadState === 'error' || !detail) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-danger">
          {loadError ?? 'Could not load the session.'}
        </CardContent>
      </Card>
    );
  }

  const s = detail.session;
  const submittedRoundsView = flattenSubmittedRounds(detail);

  return (
    <div className="space-y-4">
      {/* Session header */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Session {s.sessionNumber}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Open {formatElapsed(s.openedAt)} • Seated {formatTime(s.openedAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {s.guestCount ? (
              <span className="inline-flex items-center gap-1">
                <Users className="h-4 w-4" aria-hidden="true" />
                {s.guestCount} guest{s.guestCount === 1 ? '' : 's'}
              </span>
            ) : null}
            <StatusBadge label={s.status} tone={s.status === 'OPEN' ? 'info' : 'muted'} />
            {s.status === 'OPEN' && canClose ? (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Receipt className="h-4 w-4" />}
                onClick={() => setShowCloseConfirm(true)}
              >
                Close & bill
              </Button>
            ) : null}
            {s.status !== 'OPEN' && s.finalSaleId ? (
              <Button
                size="sm"
                onClick={() => router.push(`/bills/${s.finalSaleId}`)}
              >
                Open bill
              </Button>
            ) : null}
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Menu grid (2/3) */}
        <div className="space-y-3 lg:col-span-2">
          {menuData.menus.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                No active menu configured. Publish a menu with sections and items before
                taking orders.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {menuData.menus.map((m) => (
                  <PillButton
                    key={m.id}
                    label={m.name}
                    active={m.id === selectedMenuId}
                    onClick={() => {
                      setSelectedMenuId(m.id);
                      const firstSec = menuData.sectionsByMenu.get(m.id)?.[0];
                      setSelectedSectionId(firstSec?.id ?? null);
                    }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-2 border-l-2 border-border pl-3">
                {currentSections.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    This menu has no sections yet.
                  </span>
                ) : (
                  currentSections.map((sec) => (
                    <PillButton
                      key={sec.id}
                      label={sec.name}
                      active={sec.id === selectedSectionId}
                      onClick={() => setSelectedSectionId(sec.id)}
                    />
                  ))
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {currentItems.length === 0 ? (
                  <div className="col-span-full rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                    No items in this section.
                  </div>
                ) : (
                  currentItems.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => addSimpleItem(it)}
                      className="flex h-full flex-col rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary hover:shadow"
                    >
                      <span className="text-sm font-semibold leading-tight">{it.name}</span>
                      {it.description ? (
                        <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {it.description}
                        </span>
                      ) : null}
                      <span className="mt-auto pt-2 text-sm font-semibold text-primary">
                        {formatMoney(it.basePrice)}
                      </span>
                      {it.modifierGroupIds.length > 0 ? (
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Modifiers
                        </span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* Draft + rounds column (1/3) */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>New round</CardTitle>
              <span className="text-sm font-semibold">{formatMoney(draftSubtotal)}</span>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Tap items on the left to build the next round.
                </p>
              ) : (
                <ul className="space-y-3">
                  {draft.map((r) => (
                    <li key={r.key} className="rounded-lg border border-border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{r.name}</p>
                          {r.modifiers.length > 0 ? (
                            <ul className="mt-0.5 text-xs text-muted-foreground">
                              {r.modifiers.map((m) => (
                                <li key={m.optionId}>
                                  + {m.optionName}
                                  {Number(m.priceDelta) !== 0
                                    ? ` (${formatMoney(m.priceDelta)})`
                                    : ''}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(r.key)}
                          aria-label="Remove line"
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-1">
                          <IconButton onClick={() => changeQty(r.key, -1)} aria-label="Decrease">
                            <Minus className="h-4 w-4" />
                          </IconButton>
                          <span className="min-w-6 text-center text-sm font-semibold">
                            {r.quantity}
                          </span>
                          <IconButton onClick={() => changeQty(r.key, +1)} aria-label="Increase">
                            <Plus className="h-4 w-4" />
                          </IconButton>
                        </div>
                        <span className="text-sm font-semibold">
                          {formatMoney(
                            r.quantity *
                              (Number(r.unitPrice) +
                                r.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0)),
                          )}
                        </span>
                      </div>
                      <Input
                        placeholder="Special instructions"
                        value={r.specialInstructions}
                        onChange={(e) => setInstructions(r.key, e.target.value)}
                        className="mt-2 h-9 text-sm"
                      />
                    </li>
                  ))}
                </ul>
              )}
              {sendError ? <p className="text-sm text-danger">{sendError}</p> : null}
              <Button
                fullWidth
                size="lg"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={send}
                isLoading={sending}
                disabled={draft.length === 0 || !canSend}
              >
                Send to kitchen
              </Button>
              {!canSend ? (
                <p className="text-xs text-muted-foreground">
                  Your role can build a round but not send it to the kitchen.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Previous rounds</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {submittedRoundsView.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No rounds sent yet.
                </p>
              ) : (
                submittedRoundsView.map(({ order, round, items }) => (
                  <RoundBlock
                    key={round.id}
                    order={order}
                    round={round}
                    items={items}
                    canVoid={canVoid}
                    onVoid={setVoidTarget}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {modifierTarget ? (
        <ModifierPickerDialog
          item={modifierTarget}
          groupsById={menuData.modifierGroupsById}
          onCancel={() => setModifierTarget(null)}
          onConfirm={(lines) => {
            // Same merge rule as the fast add: a customised line only merges
            // when its whole configuration is identical to an existing row.
            setDraft((rows) => lines.reduce(addDraftLine, rows));
            setModifierTarget(null);
          }}
        />
      ) : null}
      {voidTarget ? (
        <VoidItemDialog
          item={voidTarget}
          onCancel={() => setVoidTarget(null)}
          onConfirm={voidItem}
        />
      ) : null}
      {showCloseConfirm ? (
        <Dialog
          open
          onClose={() => setShowCloseConfirm(false)}
          title="Close and generate bill?"
          description="No more rounds can be sent after closing. You will be taken to the bill to collect payment."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setShowCloseConfirm(false)}
                disabled={closingBill}
              >
                Not yet
              </Button>
              <Button onClick={closeAndBill} isLoading={closingBill}>
                Close & bill
              </Button>
            </>
          }
        >
          {closeError ? (
            <p className="text-sm text-danger">{closeError}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Any draft items still in the &ldquo;New round&rdquo; panel will be lost.
            </p>
          )}
        </Dialog>
      ) : null}
      {releaseReminder && branchId ? (
        <OpenTableReleaseReminder
          session={session}
          branchId={branchId}
          stillReserved={releaseReminder.stillReserved}
          canRelease={canManageOpenTables}
          onContinue={() => router.push(`/bills/${releaseReminder.saleId}`)}
        />
      ) : null}
      <span aria-hidden="true" className="hidden">
        {branchId}
      </span>
    </div>
  );
}

// ── Support components ─────────────────────────────────────────────────────

function PillButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center rounded-full px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-foreground hover:bg-border'
      }`}
    >
      {label}
    </button>
  );
}

function IconButton({
  children,
  onClick,
  ...aria
}: {
  children: React.ReactNode;
  onClick: () => void;
  'aria-label': string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...aria}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
    >
      {children}
    </button>
  );
}

function RoundBlock({
  order,
  round,
  items,
  canVoid,
  onVoid,
}: {
  order: OrderView;
  round: RoundView;
  items: SessionDetailItem[];
  canVoid: boolean;
  onVoid: (item: SessionDetailItem) => void;
}) {
  const total = items.reduce((sum, it) => {
    if (it.status === 'VOIDED') return sum;
    return sum + Number(it.quantity) * (Number(it.unitPrice) + Number(it.modifierTotal));
  }, 0);
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="font-semibold">Round #{round.roundNumber}</span>
          <span className="ml-2 text-xs text-muted-foreground">Order {order.orderNumber}</span>
        </div>
        <StatusBadge
          label={ROUND_STATUS_LABELS[round.status]}
          tone={ROUND_STATUS_TONES[round.status]}
        />
      </div>
      <ul className="space-y-1">
        {items.map((it) => {
          const isVoid = it.status === 'VOIDED';
          return (
            <li
              key={it.id}
              className={`flex items-start justify-between gap-2 text-sm ${
                isVoid ? 'text-muted-foreground line-through' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{Number(it.quantity)} × {it.menuItemName}</span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {ORDER_ITEM_STATUS_LABELS[it.status]}
                  </span>
                </div>
                {it.modifiers.length > 0 ? (
                  <ul className="text-xs text-muted-foreground">
                    {it.modifiers.map((m, i) => (
                      <li key={`${it.id}-mod-${i}`}>
                        + {m.optionName}
                        {Number(m.priceDelta) !== 0 ? ` (${formatMoney(m.priceDelta)})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {it.specialInstructions ? (
                  <p className="text-xs italic text-muted-foreground">
                    &ldquo;{it.specialInstructions}&rdquo;
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-sm font-medium">
                  {formatMoney(
                    Number(it.quantity) *
                      (Number(it.unitPrice) + Number(it.modifierTotal)),
                  )}
                </span>
                {!isVoid && canVoid ? (
                  <button
                    type="button"
                    onClick={() => onVoid(it)}
                    className="text-xs font-medium text-danger hover:underline"
                  >
                    Void
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 border-t border-border pt-2 text-right text-sm font-semibold">
        {formatMoney(total)}
      </div>
    </div>
  );
}

// ModifierPickerDialog moved to components/pos/modifier-picker-dialog.tsx.

function VoidItemDialog({
  item,
  onCancel,
  onConfirm,
}: {
  item: SessionDetailItem;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to void item');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Void ${item.menuItemName}?`}
      description="Voids are audited. Give the manager a short reason."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Keep item
          </Button>
          <Button variant="destructive" onClick={submit} isLoading={saving} disabled={!reason.trim()}>
            Void item
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="text-sm font-medium" htmlFor="void-reason">
          Reason
        </label>
        <Input
          id="void-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Guest changed mind"
          autoFocus
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function firstActiveOrderId(detail: SessionDetail): string | null {
  for (const bundle of detail.orders) {
    if (
      bundle.order.status !== 'CANCELLED' &&
      bundle.order.status !== 'COMPLETED'
    ) {
      return bundle.order.id;
    }
  }
  return null;
}

interface FlatRound {
  order: OrderView;
  round: RoundView;
  items: SessionDetailItem[];
}

function flattenSubmittedRounds(detail: SessionDetail): FlatRound[] {
  const rows: FlatRound[] = [];
  for (const bundle of detail.orders) {
    for (const r of bundle.rounds) {
      if (r.round.status === 'DRAFT') continue;
      rows.push({ order: bundle.order, round: r.round, items: r.items });
    }
  }
  return rows.sort((a, b) => b.round.roundNumber - a.round.roundNumber);
}

// cryptoRandomKey moved to components/pos/pos-utils.ts.


/**
 * D50 — the billing reminder.
 *
 * A close only frees a shared table when no other open table still holds it.
 * Anything left over is a floor judgement — the remaining party may or may not
 * still need it — so this interrupts the close→bill navigation once, names the
 * tables and who holds them, and offers release inline. Dismissing it
 * continues to the bill with nothing changed: it is a decision point, not a
 * nag, and it never releases anything on its own.
 */
function OpenTableReleaseReminder({
  session,
  branchId,
  stillReserved,
  canRelease,
  onContinue,
}: {
  session: Session;
  branchId: string;
  stillReserved: OpenTableReleaseSummary['stillReserved'];
  canRelease: boolean;
  onContinue: () => void;
}) {
  const [released, setReleased] = React.useState<Set<string>>(new Set());
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const release = async (tableId: string) => {
    if (busyId) return;
    setBusyId(tableId);
    setError(null);
    try {
      await openTables.releaseMember(session, branchId, tableId);
      setReleased((prev) => new Set(prev).add(tableId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unreserve the table');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onContinue}
      title="Any tables to free up?"
      description="The bill is closed. These tables stay reserved because another party is still using the arrangement."
      footer={
        <Button onClick={onContinue}>Continue to bill</Button>
      }
    >
      <div className="space-y-3">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {stillReserved.map((t) => {
          const done = released.has(t.id);
          return (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{t.label ?? t.code}</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Held by {t.heldBy.map((o) => o.label ?? o.code).join(', ')}
                </p>
              </div>
              {done ? (
                <span className="shrink-0 text-sm font-medium text-success">Freed</span>
              ) : canRelease ? (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Unlink className="h-4 w-4" />}
                  isLoading={busyId === t.id}
                  onClick={() => void release(t.id)}
                >
                  Unreserve
                </Button>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          Leave them reserved if the remaining party still needs the space — they
          free themselves when the last tab closes.
        </p>
      </div>
    </Dialog>
  );
}
