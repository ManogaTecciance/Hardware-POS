'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
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
  onCancel,
  onConfirm,
}: {
  item: MenuItemView;
  groupsById: Map<string, ModifierGroupView>;
  onCancel: () => void;
  onConfirm: (lines: DraftLine[]) => void;
}) {
  const groups = item.modifierGroupIds
    .map((id) => groupsById.get(id))
    .filter((g): g is ModifierGroupView => Boolean(g));
  const [selected, setSelected] = React.useState<Record<string, string[]>>({});
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
        key: cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.basePrice,
        quantity: 1,
        specialInstructions: '',
        modifiers: lineModifiers,
      },
    ]);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Customise: ${item.name}`}
      description="Choose the modifiers, then add to the round."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>Add to round</Button>
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
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
