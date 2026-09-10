'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { type Session } from '@/lib/auth';
import { tableSessions } from '@/lib/restaurant/api';
import {
  ORDER_ITEM_STATUS_LABELS,
  ROUND_STATUS_LABELS,
  ROUND_STATUS_TONES,
  formatMoney,
} from '@/lib/restaurant/labels';
import type {
  OrderView,
  RoundView,
  SessionDetail,
  SessionDetailItem,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  sessionId: string;
  tableLabel: string;
  /** `ORDER_VOID_SENT` — a waiter reads this sheet; a supervisor voids from it. */
  canVoid: boolean;
  onClose: () => void;
  /**
   * Fired after a void, and with the round count each load saw, so the strip
   * behind the sheet can stop guessing from what this device happened to send.
   */
  onLoaded?: (roundsSent: number) => void;
}

/**
 * D150 — what is already on the table: the rounds, their kitchen status, and
 * the void.
 *
 * This is the half of the retired `/tables/session/[id]` screen that the POS
 * did not have. The POS could compose the next round and raise the bill, but a
 * waiter tapping "View order" on the floor is asking the other question —
 * *what has this table already got, and where has the kitchen got to with it* —
 * and the only answer available was the bill sheet, which prices the order and
 * says nothing about whether it is cooked.
 *
 * Rounds read newest-first because the question is nearly always about the
 * last one. Voided lines stay on the list, struck through: the guest can see
 * the bill, so "it is not there any more" is less useful than "it was taken
 * off".
 *
 * Polls while open, at the same 8 s cadence the floor plan uses — fast enough
 * to catch a bump between glances, slow enough for a tablet on house wifi.
 */
export function SessionRoundsSheet({
  session,
  sessionId,
  tableLabel,
  canVoid,
  onClose,
  onLoaded,
}: Props) {
  const [detail, setDetail] = React.useState<SessionDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voidTarget, setVoidTarget] = React.useState<SessionDetailItem | null>(null);

  /*
   * `onLoaded` is called from a ref rather than from the effect's dependency
   * list: the caller passes an inline arrow, so depending on it would re-run
   * the fetch (and restart the poll) on every parent render.
   */
  const loadedRef = React.useRef(onLoaded);
  loadedRef.current = onLoaded;

  const load = React.useCallback(async () => {
    try {
      const fetched = await tableSessions.getDetail(session, sessionId);
      setDetail(fetched);
      setError(null);
      loadedRef.current?.(flattenSubmittedRounds(fetched).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this order');
    } finally {
      setLoading(false);
    }
  }, [session, sessionId]);

  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const voidItem = async (reason: string) => {
    if (!voidTarget) return;
    await tableSessions.voidItem(session, voidTarget.id, { reason });
    setVoidTarget(null);
    await load();
  };

  const rounds = detail ? flattenSubmittedRounds(detail) : [];

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        height="full"
        title={`${tableLabel} — order so far`}
        description="Every round sent to the kitchen on this table, newest first."
      >
        {loading && !detail ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the order…
          </p>
        ) : error && !detail ? (
          <p className="py-8 text-sm text-danger">{error}</p>
        ) : rounds.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            Nothing has been sent to the kitchen for {tableLabel} yet. Build a round on the
            menu and it will appear here.
          </p>
        ) : (
          <div className="space-y-3">
            {/* A failed POLL keeps the last good list on screen and says so:
                blanking a waiter's order because one refresh timed out is the
                worse of the two failures. */}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {rounds.map(({ order, round, items }) => (
              <RoundBlock
                key={round.id}
                order={order}
                round={round}
                items={items}
                canVoid={canVoid}
                onVoid={setVoidTarget}
              />
            ))}
          </div>
        )}
      </Sheet>
      {voidTarget ? (
        <VoidItemDialog
          item={voidTarget}
          onCancel={() => setVoidTarget(null)}
          onConfirm={voidItem}
        />
      ) : null}
    </>
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
                  <span className="font-medium">
                    {Number(it.quantity)} × {it.menuItemName}
                  </span>
                  {/* D46 — "Medium" vs "Large" is what the guest is charged for. */}
                  {it.variantName ? (
                    <span className="text-xs text-muted-foreground">{it.variantName}</span>
                  ) : null}
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
                {/* D72 — the note the guest asked for, on the line they will
                    point at when they query the charge. */}
                {it.specialInstructions ? (
                  <p className="text-xs italic text-muted-foreground">
                    &ldquo;{it.specialInstructions}&rdquo;
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-sm font-medium">
                  {formatMoney(
                    Number(it.quantity) * (Number(it.unitPrice) + Number(it.modifierTotal)),
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
          <Button
            variant="destructive"
            onClick={submit}
            isLoading={saving}
            disabled={!reason.trim()}
          >
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

interface FlatRound {
  order: OrderView;
  round: RoundView;
  items: SessionDetailItem[];
}

/**
 * Submitted rounds, newest first. DRAFT rounds are excluded: a draft round is
 * a server-side artefact of composition, not something the table has.
 */
export function flattenSubmittedRounds(detail: SessionDetail): FlatRound[] {
  const rows: FlatRound[] = [];
  for (const bundle of detail.orders) {
    for (const r of bundle.rounds) {
      if (r.round.status === 'DRAFT') continue;
      rows.push({ order: bundle.order, round: r.round, items: r.items });
    }
  }
  return rows.sort((a, b) => b.round.roundNumber - a.round.roundNumber);
}
