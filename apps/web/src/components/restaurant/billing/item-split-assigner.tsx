'use client';

import { Minus, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/restaurant/labels';

/** A line that can be divided between guests. */
export interface SplitAssignableItem {
  orderItemId: string;
  name: string;
  variantName: string | null;
  /** Unit price INCLUDING modifier deltas — what the guest is charged. */
  unitPrice: string;
  quantity: string;
}

/** What the caller sends to `POST /bills/:saleId/split-by-items`. */
export interface ComposedSplit {
  label?: string;
  items: { orderItemId: string; quantity: number }[];
}

interface DraftSplit {
  key: string;
  label: string;
  /** orderItemId → assigned quantity for this split. */
  assigned: Map<string, number>;
}

interface Props {
  items: SplitAssignableItem[];
  onCancel: () => void;
  onSubmit: (splits: ComposedSplit[]) => void | Promise<void>;
  /** Verb for the primary action; the bill count is appended. */
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
}

/**
 * D71 — dividing a bill by what each person ate.
 *
 * Extracted from the bill screen (D51) so the WAITER can do this at the
 * table and the CASHIER can do it at the till through the same surface. It
 * was a private component inside the bill screen; a second copy for the POS
 * would have been two split UIs with one set of money rules between them,
 * and they would have drifted the first time either was touched.
 *
 * The component owns only the assignment. It never calls the API — the
 * caller does, because the two callers differ in one important way: the
 * cashier splits an existing Sale, while the waiter is splitting a session
 * that has to be CLOSED first to have a Sale at all.
 *
 * Assignment is by unit, not by line, so half a shared platter can go on one
 * bill and half on another. Every unit must land somewhere: an unassigned
 * unit is a share of the bill nobody will ever pay, and the server refuses
 * it anyway.
 */
export function ItemSplitAssigner({
  items,
  onCancel,
  onSubmit,
  submitLabel = 'Create',
  busy = false,
  error = null,
}: Props) {
  const [splits, setSplits] = React.useState<DraftSplit[]>(() => [
    { key: key(), label: 'Guest 1', assigned: new Map() },
    { key: key(), label: 'Guest 2', assigned: new Map() },
  ]);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  const active = splits.find((s) => s.key === activeKey) ?? splits[0];
  React.useEffect(() => {
    if (!activeKey && splits[0]) setActiveKey(splits[0].key);
  }, [activeKey, splits]);

  const assignedTotal = (itemId: string) =>
    splits.reduce((n, s) => n + (s.assigned.get(itemId) ?? 0), 0);
  const remainingOf = (item: SplitAssignableItem) =>
    Number(item.quantity) - assignedTotal(item.orderItemId);
  const unassignedUnits = items.reduce((n, it) => n + remainingOf(it), 0);

  const splitSubtotal = (split: DraftSplit) =>
    items.reduce((sum, it) => {
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

  const add = (item: SplitAssignableItem, units: number) => {
    const step = Math.min(units, remainingOf(item));
    if (step <= 0) return;
    mutateActive((m) => m.set(item.orderItemId, (m.get(item.orderItemId) ?? 0) + step));
  };
  const remove = (item: SplitAssignableItem, units: number) => {
    mutateActive((m) => {
      const next = Math.max(0, (m.get(item.orderItemId) ?? 0) - units);
      if (next === 0) m.delete(item.orderItemId);
      else m.set(item.orderItemId, next);
    });
  };

  const addSplit = () =>
    setSplits((prev) => [
      ...prev,
      { key: key(), label: `Guest ${prev.length + 1}`, assigned: new Map() },
    ]);

  const removeSplit = (removeKey: string) =>
    setSplits((prev) => {
      const next = prev.filter((s) => s.key !== removeKey);
      if (removeKey === activeKey) setActiveKey(next[0]?.key ?? null);
      return next;
    });

  const nonEmpty = splits.filter((s) => s.assigned.size > 0);
  const valid = unassignedUnits === 0 && nonEmpty.length > 0;

  const submit = () => {
    if (!valid || busy) return;
    void onSubmit(
      nonEmpty.map((s) => ({
        label: s.label.trim() || undefined,
        items: [...s.assigned.entries()].map(([orderItemId, quantity]) => ({
          orderItemId,
          quantity,
        })),
      })),
    );
  };

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {/* Whose bill am I building? */}
      <div className="flex flex-wrap items-center gap-2">
        {splits.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveKey(s.key)}
            className={
              'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ' +
              (s.key === active?.key
                ? 'border-primary bg-primary/10 font-medium'
                : 'border-border')
            }
          >
            <span>{s.label}</span>
            <span className="text-xs text-muted-foreground">
              {formatMoney(splitSubtotal(s).toFixed(2))}
            </span>
          </button>
        ))}
        <Button size="sm" variant="outline" onClick={addSplit} leftIcon={<Plus className="h-4 w-4" />}>
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
        {items.map((it) => {
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
                    <span className="text-warning"> · {trimQuantity(String(left))} unassigned</span>
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
            onClick={() => items.forEach((it) => add(it, remainingOf(it)))}
          >
            Assign rest to {active.label}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        Service charge and other bill-level amounts are shared across the new bills in proportion
        to what each covers.
      </p>

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} isLoading={busy} disabled={!valid}>
          {submitLabel} {nonEmpty.length || ''} bill{nonEmpty.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

/** "2.000" reads as machinery; "2" and "0.5" read as plates. */
function trimQuantity(q: string): string {
  return String(Number(q));
}

function key(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k_${Math.random().toString(36).slice(2)}`;
}
