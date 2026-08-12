'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView, ModifierGroupView } from '@/lib/restaurant/types';

import { cryptoRandomKey } from './pos-utils';
import type { DraftLine } from './pos-types';

/**
 * The modifier picker used by every POS mode and by the dine-in order
 * entry. Emits one or more `DraftLine` entries — one per confirmed
 * modifier set — which the caller appends to its own local draft.
 *
 * min/max enforcement lives here, not on the server, only because a
 * client-side check gives a friendlier error and the server still refuses
 * a malformed round if the client is bypassed. The shape of every option's
 * `priceDelta` is a decimal string; consumers must add it into their
 * running total via Number().
 */
export function ModifierPickerDialog({
  item,
  groupsById,
  initialLine,
  initialQuantity,
  initialInstructions,
  onCancel,
  onConfirm,
}: {
  item: MenuItemView;
  groupsById: Map<string, ModifierGroupView>;
  /** When re-opening the dialog for an existing cart line, its previous
   *  modifier picks + quantity + notes seed the initial state — Pilot
   *  Change 3 Section 7. */
  initialLine?: DraftLine | null;
  initialQuantity?: number;
  initialInstructions?: string;
  onCancel: () => void;
  onConfirm: (lines: DraftLine[]) => void;
}) {
  const groups = item.modifierGroupIds
    .map((id) => groupsById.get(id))
    .filter((g): g is ModifierGroupView => Boolean(g));
  const [selected, setSelected] = React.useState<Record<string, string[]>>(() => {
    if (!initialLine) return {};
    // Rebuild the group → optionIds map from the existing line snapshot.
    const map: Record<string, string[]> = {};
    for (const g of groups) {
      const picked = initialLine.modifiers
        .filter((m) => g.options.some((o) => o.id === m.optionId))
        .map((m) => m.optionId);
      if (picked.length > 0) map[g.id] = picked;
    }
    return map;
  });
  const [quantity, setQuantity] = React.useState(initialQuantity ?? initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = React.useState(
    initialInstructions ?? initialLine?.specialInstructions ?? '',
  );
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (group: ModifierGroupView, optionId: string) => {
    setSelected((cur) => {
      const current = cur[group.id] ?? [];
      const isSelected = current.includes(optionId);
      let next: string[];
      if (group.selection === 'SINGLE') {
        next = isSelected ? [] : [optionId];
      } else if (isSelected) {
        next = current.filter((x) => x !== optionId);
      } else {
        next = [...current, optionId];
      }
      return { ...cur, [group.id]: next };
    });
  };

  const confirm = () => {
    for (const g of groups) {
      const count = (selected[g.id] ?? []).length;
      if (count < g.minSelections) {
        setError(`Pick at least ${g.minSelections} from ${g.name}.`);
        return;
      }
      if (g.maxSelections > 0 && count > g.maxSelections) {
        setError(`${g.name} allows at most ${g.maxSelections}.`);
        return;
      }
    }
    const lineModifiers: DraftLine['modifiers'] = [];
    for (const g of groups) {
      for (const optId of selected[g.id] ?? []) {
        const opt = g.options.find((o) => o.id === optId);
        if (!opt) continue;
        lineModifiers.push({
          optionId: opt.id,
          optionName: opt.name,
          groupName: g.name,
          priceDelta: opt.priceDelta,
        });
      }
    }
    onConfirm([
      {
        key: initialLine?.key ?? cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.basePrice,
        quantity,
        specialInstructions: instructions,
        modifiers: lineModifiers,
        // Preserve any existing discount on the original line — Edit
        // must not silently wipe it.
        ...(initialLine?.discount ? { discount: initialLine.discount } : {}),
      },
    ]);
  };

  return (
    // Hard swap from `<Dialog>` (max-w-md) to `<Sheet height="full">`. A 448px
    // dialog on a 1024px iPad has enough dead space to hide a modifier group,
    // and even on desktop 1440 a taller sheet with room for 6+ groups reads
    // better than a scrolling card. `sm:max-w-2xl` caps the panel on wide
    // viewports so it stays centred rather than stretching to screen edges;
    // the `<Sheet>` primitive already centres via `mx-auto` at `tab:`.
    <Sheet
      open
      onClose={onCancel}
      height="full"
      title={`Customise: ${item.name}`}
      description="Choose the modifiers, then add to the round."
      className="sm:max-w-2xl touch-manipulation"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>
            {initialLine ? 'Update item' : 'Add to Cart'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No modifier groups are configured for this item — it will be added as-is.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.id}>
              <div className="mb-1 flex items-baseline justify-between">
                <p className="text-sm font-medium">{g.name}</p>
                <p className="text-xs text-muted-foreground">
                  {g.selection === 'SINGLE'
                    ? 'Pick one'
                    : `Pick ${g.minSelections}${
                        g.maxSelections > 0 ? `–${g.maxSelections}` : '+'
                      }`}
                </p>
              </div>
              <ul className="space-y-1">
                {g.options.map((opt) => {
                  const isChecked = (selected[g.id] ?? []).includes(opt.id);
                  return (
                    <li key={opt.id}>
                      <label className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface p-2 text-sm">
                        <span className="inline-flex items-center gap-2">
                          <input
                            type={g.selection === 'SINGLE' ? 'radio' : 'checkbox'}
                            name={`grp-${g.id}`}
                            checked={isChecked}
                            onChange={() => toggle(g, opt.id)}
                          />
                          <span>{opt.name}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {Number(opt.priceDelta) === 0
                            ? '—'
                            : `+ ${formatMoney(opt.priceDelta)}`}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="modifier-instructions">
            Special instructions
          </label>
          <Input
            id="modifier-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. don't add beef"
          />
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          {/* Quantity stepper is a primary interaction on every mode — bumped
              from h-9 to h-11 so it always meets the 44px touch minimum on
              coarse pointers, whether or not the enclosing surface opted into
              `.touch-target-coarse`. */}
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border text-lg font-medium hover:bg-muted touch-manipulation"
            >
              −
            </button>
            <span className="min-w-8 text-center text-base font-semibold tabular-nums">
              {quantity}
            </span>
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => setQuantity((q) => q + 1)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border text-lg font-medium hover:bg-muted touch-manipulation"
            >
              +
            </button>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Item total</p>
            <p className="text-lg font-bold tabular-nums text-primary">
              {formatMoney(
                quantity *
                  (Number(item.basePrice) +
                    Object.entries(selected).reduce((sum, [gid, optIds]) => {
                      const g = groups.find((x) => x.id === gid);
                      if (!g) return sum;
                      return (
                        sum +
                        optIds.reduce((s, oid) => {
                          const o = g.options.find((x) => x.id === oid);
                          return s + (o ? Number(o.priceDelta) : 0);
                        }, 0)
                      );
                    }, 0)),
              )}
            </p>
          </div>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}
