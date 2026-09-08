'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatMoney } from '@/lib/restaurant/labels';
import type {
  MenuItemVariantView,
  MenuItemView,
  ModifierGroupView,
} from '@/lib/restaurant/types';

import { cryptoRandomKey } from './pos-utils';
import type { DraftLine } from './pos-types';

/**
 * The Customise dialog used by every POS mode and by the dine-in order
 * entry. Emits one `DraftLine` — the caller appends (or replaces, in
 * edit mode) into its own local draft.
 *
 * D46 adds Product Variations: when `item.variants` is non-empty, a
 * single-select radiogroup renders ABOVE the modifier groups. The variant
 * price is ABSOLUTE (not a delta on `item.basePrice`) — the live total
 * takes `variant.unitPrice ?? item.basePrice`, plus modifier deltas,
 * times quantity. Adding the two together is the D46 anti-pattern; a
 * render test guards against it.
 *
 * min/max modifier enforcement lives here, not on the server, only
 * because a client-side check gives a friendlier error and the server
 * still refuses a malformed round if the client is bypassed. Every
 * option's `priceDelta` is a decimal string; consumers must add it into
 * their running total via Number().
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
   *  modifier picks + quantity + notes + variant seed the initial state. */
  initialLine?: DraftLine | null;
  initialQuantity?: number;
  initialInstructions?: string;
  onCancel: () => void;
  onConfirm: (lines: DraftLine[]) => void;
}) {
  const groups = item.modifierGroupIds
    .map((id) => groupsById.get(id))
    .filter((g): g is ModifierGroupView => Boolean(g));

  // ── Variant state (D46) ────────────────────────────────────────────────
  // `variants` on the view is already filtered to actives for the runtime
  // adapter (`toMenuItemView`), but the dialog is defensive — a caller
  // might pass a raw list including inactives (e.g. an admin preview).
  // Both branches disable inactive rows below.
  //
  // Memoised because a fresh `??` literal every render would rotate the
  // useMemo dependency arrays below on every keystroke (react-hooks/
  // exhaustive-deps warns otherwise).
  const variants: MenuItemVariantView[] = React.useMemo(
    () => item.variants ?? [],
    [item.variants],
  );
  const hasVariants = variants.length > 0;
  const activeVariants = React.useMemo(
    () => variants.filter((v) => v.isActive),
    [variants],
  );

  // Preselect strategy — brief D46 Phase 4:
  //   1. Existing edit-mode line: honour its `productVariantId`.
  //   2. Otherwise: variant marked `isDefault=true` wins.
  //   3. Otherwise, if exactly one active variant exists, auto-select it
  //      (no point forcing a pointless tap).
  //   4. Otherwise no preselect — Add to Cart stays disabled and a hint
  //      appears once the operator interacts (dirty flag).
  const preselectVariantId = React.useMemo(() => {
    if (initialLine?.productVariantId) {
      const hit = variants.find((v) => v.id === initialLine.productVariantId);
      if (hit) return hit.id;
    }
    if (!hasVariants) return null;
    const explicitDefault = activeVariants.find((v) => v.isDefault);
    if (explicitDefault) return explicitDefault.id;
    if (activeVariants.length === 1) return activeVariants[0]!.id;
    return null;
  }, [initialLine?.productVariantId, hasVariants, variants, activeVariants]);

  const [selectedVariantId, setSelectedVariantId] = React.useState<string | null>(
    preselectVariantId,
  );

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

  // Dirty flag — the "Select a size to continue" hint only appears after
  // the operator has interacted with the dialog. Muting it on first open
  // keeps the empty-preselect state from reading as an error immediately;
  // the operator sees it once they try to proceed OR touch a modifier.
  const [dirty, setDirty] = React.useState<boolean>(false);

  const markDirty = () => setDirty(true);

  const toggle = (group: ModifierGroupView, optionId: string) => {
    markDirty();
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

  const pickVariant = (variantId: string) => {
    markDirty();
    setSelectedVariantId(variantId);
  };

  const selectedVariant = React.useMemo(
    () => (selectedVariantId ? variants.find((v) => v.id === selectedVariantId) ?? null : null),
    [selectedVariantId, variants],
  );

  // Live item total — brief B2:
  //   itemTotal = (variantPrice ?? item.basePrice) + Σ selectedModifiers.priceDelta
  //   itemTotal *= quantity
  // The variant price is ABSOLUTE; never base + variant. A render test
  // (`customise-dialog.render.test.tsx`) pins this to catch a future
  // refactor that reintroduces the D46 anti-pattern.
  const effectiveUnitPrice = selectedVariant
    ? selectedVariant.unitPrice
    : Number(item.basePrice);
  const modifierDeltaSum = Object.entries(selected).reduce((sum, [gid, optIds]) => {
    const g = groups.find((x) => x.id === gid);
    if (!g) return sum;
    return (
      sum +
      optIds.reduce((s, oid) => {
        const o = g.options.find((x) => x.id === oid);
        return s + (o ? Number(o.priceDelta) : 0);
      }, 0)
    );
  }, 0);
  const itemTotal = quantity * (effectiveUnitPrice + modifierDeltaSum);

  // Add to Cart is blocked while any variant is required but unpicked.
  // The hint text only surfaces once `dirty` — see markDirty rationale.
  const needsVariantSelection = hasVariants && !selectedVariantId;
  const primaryDisabled = needsVariantSelection;

  const confirm = () => {
    if (needsVariantSelection) {
      markDirty();
      setError('Select a size to continue.');
      return;
    }
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

    // Cart identity + source discriminator (D46). For catalogue-sourced
    // items `item.id` is the productId; for legacy MenuItems it's the
    // MenuItem id. `menuItemId` on DraftLine deliberately carries either —
    // it is the cart-line identity, not a wire field. Wire mapping happens
    // in the workspace's submit call site.
    const isProductSource = item.catalogueSource === 'PRODUCT';
    onConfirm([
      {
        key: initialLine?.key ?? cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        // Snapshot the effective unit — the operator's cart view must
        // match the picked variant's price without a re-derive.
        unitPrice: String(effectiveUnitPrice),
        quantity,
        specialInstructions: instructions,
        modifiers: lineModifiers,
        // Preserve any existing discount on the original line — Edit
        // must not silently wipe it.
        ...(initialLine?.discount ? { discount: initialLine.discount } : {}),
        // D46 — source metadata.
        sourceKind: isProductSource ? 'PRODUCT' : 'MENU_ITEM',
        ...(isProductSource ? { productId: item.id } : {}),
        ...(selectedVariant
          ? {
              productVariantId: selectedVariant.id,
              variantName: selectedVariant.name,
              variantPrice: String(selectedVariant.unitPrice),
            }
          : {}),
      },
    ]);
  };

  // Variation-dimension heading. The wizard names its variation group
  // via a `role`-tagged ModifierGroup (`role === 'SIZE'`) elsewhere; the
  // POS Catalogue delivers variants as a flat array without a group name,
  // so we fall back to `SIZE` per the brief.
  const variantHeading = 'SIZE';

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
      description="Choose a size and modifiers, then add to the round."
      className="sm:max-w-2xl touch-manipulation"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {/* Primary tap must remain event-firing even when a variant
              is unpicked — the dirty-gated hint only surfaces after the
              operator interacts, and a hard `disabled` swallows the tap
              so the dirty flag would never flip. `aria-disabled` +
              opacity keep the affordance clear without eating the
              event; `confirm()` refuses the submit and shows the hint. */}
          <Button
            onClick={confirm}
            aria-disabled={primaryDisabled || undefined}
            className={primaryDisabled ? 'opacity-50 cursor-not-allowed' : undefined}
          >
            {initialLine ? 'Update item' : 'Add to Cart'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hasVariants ? (
          <VariantSection
            heading={variantHeading}
            variants={variants}
            selectedId={selectedVariantId}
            onPick={pickVariant}
          />
        ) : null}

        {groups.length === 0 && !hasVariants ? (
          <p className="text-sm text-muted-foreground">
            No modifier groups are configured for this item — it will be added as-is.
          </p>
        ) : null}

        {groups.map((g) => (
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
        ))}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="modifier-instructions">
            Special instructions
          </label>
          <Input
            id="modifier-instructions"
            value={instructions}
            onChange={(e) => {
              markDirty();
              setInstructions(e.target.value);
            }}
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
              onClick={() => {
                markDirty();
                setQuantity((q) => Math.max(1, q - 1));
              }}
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
              onClick={() => {
                markDirty();
                setQuantity((q) => q + 1);
              }}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border text-lg font-medium hover:bg-muted touch-manipulation"
            >
              +
            </button>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Item total</p>
            <p className="text-lg font-bold tabular-nums text-primary transition-[color,opacity] duration-150">
              {formatMoney(itemTotal)}
            </p>
          </div>
        </div>

        {/* Dirty-gated variant hint. Kept below the total so it does not
            reflow the primary tap target when it appears; the disabled
            Add-to-Cart button is the primary block, the hint only
            explains why. */}
        {needsVariantSelection && dirty ? (
          <p className="text-sm text-warning" role="status">
            Select a size to continue
          </p>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/**
 * SIZE radiogroup — single-select, rendered above modifier groups when
 * the item carries variants. Inactive rows render disabled with an
 * "Unavailable" chip; they set `aria-disabled` and are removed from the
 * tab order so keyboard/AT users cannot land on them (`tabIndex={-1}`).
 *
 * The whole row is tappable, not just the tiny radio circle — the row
 * is `min-h-11` to guarantee the 44px touch target the counter POS
 * spec calls for.
 */
function VariantSection({
  heading,
  variants,
  selectedId,
  onPick,
}: {
  heading: string;
  variants: MenuItemVariantView[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-sm font-medium">
          {heading} <span className="text-danger">*</span>
        </p>
        <p className="text-xs text-muted-foreground">Pick one</p>
      </div>
      <ul
        role="radiogroup"
        aria-label={heading}
        aria-required="true"
        className="space-y-1"
      >
        {variants.map((v) => {
          const isSelected = v.id === selectedId;
          const disabled = !v.isActive;
          return (
            <li key={v.id}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                // Only the currently-selected (or first, when none) radio
                // participates in the tab order; arrow keys traverse the
                // rest. Standard radiogroup pattern.
                tabIndex={disabled ? -1 : isSelected || (!selectedId && v === variants.find((x) => x.isActive)) ? 0 : -1}
                onClick={() => {
                  if (disabled) return;
                  onPick(v.id);
                }}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const idx = variants.indexOf(v);
                    for (let i = 1; i <= variants.length; i++) {
                      const next = variants[(idx + i) % variants.length];
                      if (next && next.isActive) {
                        onPick(next.id);
                        break;
                      }
                    }
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const idx = variants.indexOf(v);
                    for (let i = 1; i <= variants.length; i++) {
                      const prev =
                        variants[(idx - i + variants.length) % variants.length];
                      if (prev && prev.isActive) {
                        onPick(prev.id);
                        break;
                      }
                    }
                  } else if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    onPick(v.id);
                  }
                }}
                className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md border p-2 text-left text-sm transition-colors touch-manipulation ${
                  isSelected
                    ? 'border-primary bg-brand-100'
                    : 'border-border bg-surface'
                } ${
                  disabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'hover:border-primary'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  {/* Visual radio glyph — the real semantic radio role is
                      on the button; this circle is decorative. */}
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border-strong bg-surface'
                    }`}
                  >
                    {isSelected ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                    ) : null}
                  </span>
                  <span className="font-medium">{v.name}</span>
                  {disabled ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Unavailable
                    </span>
                  ) : null}
                </span>
                <span className="text-xs font-medium tabular-nums text-foreground">
                  {formatMoney(v.unitPrice)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
