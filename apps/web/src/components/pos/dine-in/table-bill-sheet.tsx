'use client';

import { Loader2, Receipt, SplitSquareHorizontal } from 'lucide-react';
import * as React from 'react';

import { ItemSplitAssigner } from '@/components/restaurant/billing/item-split-assigner';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { type Session } from '@/lib/auth';
import { billing, tableSessions } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { SessionBillPreview } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  sessionId: string;
  tableLabel: string;
  /** True while the caller still has unsent items in the cart. */
  hasUnsentDraft: boolean;
  canSplit: boolean;
  onClose: () => void;
  /** Fired after the session is closed. `splitCount` is 0 for one bill. */
  onClosed: (result: { saleId: string; splitCount: number; warning?: string }) => void;
}

type Stage = 'review' | 'split';

/**
 * D71 — the waiter's bill, at the table.
 *
 * The waiter is the one talking to the guests, so the waiter is the one who
 * has to answer "what do we owe" and "can we pay separately". Both used to
 * live at the till, on a screen the waiter never opens, which meant the
 * cashier reconstructing who ate what from a conversation they were not part
 * of.
 *
 * Everything here reads the SERVER's numbers (`bill-preview`, priced by the
 * same calculator the close uses) rather than re-adding the cart, so what a
 * guest is shown and what they are charged cannot differ.
 *
 * ## Why the split happens around the close
 *
 * Splits attach to a Sale, and an open session has none. So the waiter
 * composes the division at the table, and confirming does two things in
 * order: close the session (which raises the Sale) and then apply the split
 * to it. If the second call fails the first still stands — the guests get
 * one bill instead of four, the cashier can split it at the till, and the
 * message below says so. The reverse order is not available and the
 * alternative — holding the close until the split succeeds — would leave a
 * table that is neither open nor billed.
 */
export function TableBillSheet({
  session,
  sessionId,
  tableLabel,
  hasUnsentDraft,
  canSplit,
  onClose,
  onClosed,
}: Props) {
  const [preview, setPreview] = React.useState<SessionBillPreview | null>(null);
  const [stage, setStage] = React.useState<Stage>('review');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await tableSessions.billPreview(session, sessionId);
        if (!cancelled) setPreview(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load this table’s bill');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, sessionId]);

  const confirmUnsent = () =>
    !hasUnsentDraft ||
    window.confirm(
      'The cart still has items that were never sent to the kitchen. They are NOT on this bill. Close the session anyway?',
    );

  const closeOnly = async () => {
    if (busy || !confirmUnsent()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await tableSessions.close(session, sessionId, {
        idempotencyKey: freshKey(),
      });
      onClosed({ saleId: result.saleId, splitCount: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the session');
      setBusy(false);
    }
  };

  const closeAndSplit = async (splits: Parameters<typeof billing.splitByItems>[2]['splits']) => {
    if (busy || !confirmUnsent()) return;
    setBusy(true);
    setError(null);
    let saleId: string;
    try {
      saleId = (
        await tableSessions.close(session, sessionId, { idempotencyKey: freshKey() })
      ).saleId;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the session');
      setBusy(false);
      return;
    }
    // Past this point the table IS closed. A failure here costs the split,
    // never the bill, and the operator is told exactly what to do next.
    try {
      await billing.splitByItems(session, saleId, { splits });
      onClosed({ saleId, splitCount: splits.length });
    } catch (err) {
      onClosed({
        saleId,
        splitCount: 0,
        warning: `${tableLabel} is closed, but the split did not save (${
          err instanceof Error ? err.message : 'unknown error'
        }). The cashier can split it on the bill screen.`,
      });
    }
  };

  const empty = preview !== null && preview.items.length === 0;

  return (
    <Sheet
      open
      onClose={busy ? () => undefined : onClose}
      height="full"
      title={`${tableLabel} — bill`}
      description={
        stage === 'split'
          ? 'Pick whose bill you are building, then add what they had.'
          : 'Everything sent to the kitchen on this table.'
      }
      footer={
        stage === 'review' && !loading && !empty ? (
          // Stacked below sm: two labelled actions side by side truncate to
          // nonsense on a narrow sheet; from sm up there is room for both.
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            {canSplit ? (
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                leftIcon={<SplitSquareHorizontal className="h-4 w-4" />}
                onClick={() => setStage('split')}
              >
                Split between guests
              </Button>
            ) : null}
            <Button
              className="flex-1"
              isLoading={busy}
              leftIcon={<Receipt className="h-4 w-4" />}
              onClick={() => void closeOnly()}
            >
              Close &amp; send one bill
            </Button>
          </div>
        ) : null
      }
    >
      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the bill…
        </p>
      ) : error && !preview ? (
        <p className="py-8 text-sm text-danger">{error}</p>
      ) : !preview ? null : empty ? (
        <p className="py-8 text-sm text-muted-foreground">
          Nothing has been sent to the kitchen for {tableLabel} yet, so there is no bill to
          settle.
        </p>
      ) : stage === 'split' ? (
        <ItemSplitAssigner
          items={preview.items}
          busy={busy}
          error={error}
          submitLabel="Close and create"
          onCancel={() => setStage('review')}
          onSubmit={closeAndSplit}
        />
      ) : (
        <div className="space-y-4">
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {hasUnsentDraft ? (
            <p className="rounded-lg border border-warning/40 bg-warning-soft/40 p-2 text-xs">
              The cart still has items that have not been sent to the kitchen. They are not on
              this bill.
            </p>
          ) : null}

          {/* Grouped by round, because that is the order the guests ate in and
              the order they will remember when they query a line. */}
          {groupByRound(preview.items).map(([round, items]) => (
            <div key={round ?? 'x'}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {round ? `Round ${round}` : 'Items'}
              </p>
              <ul className="space-y-1">
                {items.map((it) => (
                  <li key={it.orderItemId} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{trimQuantity(it.quantity)}× </span>
                      {it.name}
                      {it.variantName ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {it.variantName}
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {formatMoney(it.unitPrice)} each
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatMoney(it.lineTotal)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="space-y-1 border-t border-border pt-3 text-sm">
            <Row label="Subtotal" value={preview.subtotal} />
            {Number(preview.serviceChargeAmount) > 0 ? (
              <Row label="Service charge" value={preview.serviceChargeAmount} />
            ) : null}
            {Number(preview.packagingCharge) > 0 ? (
              <Row label="Packaging" value={preview.packagingCharge} />
            ) : null}
            {Number(preview.taxAmount) > 0 ? <Row label="Tax" value={preview.taxAmount} /> : null}
            <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(preview.total)}</span>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}

function groupByRound(
  items: SessionBillPreview['items'],
): [number | null, SessionBillPreview['items']][] {
  const byRound = new Map<number | null, SessionBillPreview['items']>();
  for (const item of items) {
    const list = byRound.get(item.roundNumber) ?? [];
    list.push(item);
    byRound.set(item.roundNumber, list);
  }
  return [...byRound.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

function trimQuantity(q: string): string {
  return String(Number(q));
}

/** A fresh key per attempt: reusing one would replay the previous close. */
function freshKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k_${Math.random().toString(36).slice(2)}`;
}
