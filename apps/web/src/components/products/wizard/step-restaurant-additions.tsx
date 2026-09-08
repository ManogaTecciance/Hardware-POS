'use client';

import { Check, ExternalLink, ListTree, Loader2, Plus, Sparkles, Timer, Utensils, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { type Session } from '@/lib/auth';
import { useAuth } from '@/lib/auth';
import {
  fetchPromotions,
  labelForPromotionType,
  summarisePromotionSchedule,
  type Promotion,
} from '@/lib/products/promotions-api';
import { modifierGroups as modifierGroupsApi, kitchenStations as kitchenStationsApi } from '@/lib/restaurant/api';
import type { KitchenStationView, ModifierGroupView } from '@/lib/restaurant/types';
import { ProductSelectorDialog } from '@/components/products/product-selector-dialog';

import type { ComponentDraft, WizardState } from './wizard-state';

/**
 * Restaurant additions to Step 3 (D45).
 *
 * Three cards, in this order:
 *
 *   A. Modifier Groups     — check-list of the tenant's ModifierGroup
 *                            catalogue. Toggles `state.modifierGroupIds`. A
 *                            "Create modifier group" button opens a Sheet with
 *                            an inline create form; on success the list is
 *                            refetched and the new group appears pre-checked.
 *
 *   B. Promotions / Offers — check-list of active Promotions. Toggles
 *                            `state.promotionIds`. Persistence is deferred:
 *                            after the product is saved the shell PATCHes each
 *                            picked promotion to add a PromotionItem pointing
 *                            at the new product id (see product-wizard.tsx).
 *                            The "Create new promotion" button opens the
 *                            promotion editor in a new tab so the wizard draft
 *                            is preserved.
 *
 *   C. Availability & Kitchen — Active switch (surfacing what already exists
 *                               on the state), Kitchen stations multi-select,
 *                               and a read-only summary of Step 1's prep time.
 *
 * The three cards render only when the wizard shell tells us the tenant is
 * Restaurant (`businessKind === 'RESTAURANT'`). All internal reads for
 * catalogues (modifier groups / stations) hit the RESTAURANT-namespaced APIs.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  session: Session;
  branchId: string | null;
  /**
   * D65 — `capabilities.catalogue.components`, resolved by the wizard shell
   * (D31: this component compares no business type or capability itself).
   */
  showRecipe: boolean;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepRestaurantAdditions({
  state,
  errors,
  session,
  branchId,
  showRecipe,
  onChange,
}: Props) {
  return (
    <div className="space-y-4">
      <ModifierGroupsCard
        session={session}
        selectedIds={state.modifierGroupIds}
        onChange={(ids) => onChange({ modifierGroupIds: ids })}
      />
      <PromotionsCard
        session={session}
        selectedIds={state.promotionIds}
        onChange={(ids) => onChange({ promotionIds: ids })}
      />
      {showRecipe ? (
        <RecipeCard state={state} errors={errors} session={session} onChange={onChange} />
      ) : null}
      <AvailabilityKitchenCard
        state={state}
        session={session}
        branchId={branchId}
        onChange={onChange}
      />
    </div>
  );
}

// ── Card A: Modifier Groups ──────────────────────────────────────────────────

function ModifierGroupsCard({
  session,
  selectedIds,
  onChange,
}: {
  session: Session;
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const [groups, setGroups] = React.useState<ModifierGroupView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    modifierGroupsApi
      .list(session)
      .then((rows) => {
        if (!cancelled) setGroups(rows.filter((g) => g.isActive));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load modifier groups');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadKey]);

  const toggle = (id: string) => {
    onChange(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Modifier groups</h3>
          <p className="text-xs text-muted-foreground">
            Pick which customer-facing option groups apply to this item.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setSheetOpen(true)}
        >
          Create modifier group
        </Button>
      </header>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" aria-hidden="true" />
          Loading modifier groups…
        </p>
      ) : error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
          No modifier groups yet. Create one to attach options like Size, Add-ons, or Spice level.
        </p>
      ) : (
        <ul className="space-y-1.5" role="group" aria-label="Modifier groups">
          {groups.map((g) => {
            const checked = selectedIds.includes(g.id);
            return (
              <li key={g.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={checked}
                    onChange={() => toggle(g.id)}
                    aria-label={`Attach ${g.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{g.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {g.selection === 'SINGLE' ? 'Single' : 'Multiple'} · {g.minSelections}-{g.maxSelections}
                      {' · '}
                      {g.options.length} option{g.options.length === 1 ? '' : 's'}
                    </p>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <ModifierGroupCreateSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        session={session}
        onCreated={(created) => {
          // Preselect the freshly-created group so the operator's intent — "I
          // created it because I want to use it here" — is honoured without a
          // second click. The subsequent list refetch will already include it.
          onChange([...selectedIds, created.id]);
          setReloadKey((k) => k + 1);
          setSheetOpen(false);
        }}
      />
    </section>
  );
}

/** Inline "Create modifier group" form, rendered inside a bottom Sheet. */
function ModifierGroupCreateSheet({
  open,
  onClose,
  session,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  onCreated: (created: ModifierGroupView) => void;
}) {
  const [name, setName] = React.useState('');
  const [selection, setSelection] = React.useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [minSel, setMinSel] = React.useState('0');
  const [maxSel, setMaxSel] = React.useState('1');
  const [options, setOptions] = React.useState<{ key: string; name: string; priceDelta: string }[]>([
    { key: 'opt-1', name: '', priceDelta: '0' },
  ]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset when the sheet opens so a subsequent open lands with a clean form.
  React.useEffect(() => {
    if (open) {
      setName('');
      setSelection('SINGLE');
      setMinSel('0');
      setMaxSel('1');
      setOptions([{ key: 'opt-1', name: '', priceDelta: '0' }]);
      setSaving(false);
      setError(null);
    }
  }, [open]);

  const addOption = () => {
    setOptions((prev) => [
      ...prev,
      { key: `opt-${prev.length + 1}-${Date.now()}`, name: '', priceDelta: '0' },
    ]);
  };
  const removeOption = (key: string) => {
    setOptions((prev) => prev.filter((o) => o.key !== key));
  };
  const patchOption = (key: string, patch: Partial<{ name: string; priceDelta: string }>) => {
    setOptions((prev) => prev.map((o) => (o.key === key ? { ...o, ...patch } : o)));
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Give the group a name.');
      return;
    }
    const cleanOptions = options
      .filter((o) => o.name.trim())
      .map((o, i) => ({
        name: o.name.trim(),
        priceDelta: Number(o.priceDelta) || 0,
        position: i,
      }));
    if (cleanOptions.length === 0) {
      setError('Add at least one option.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await modifierGroupsApi.create(session, {
        name: name.trim(),
        selection,
        minSelections: Number(minSel) || 0,
        maxSelections: Number(maxSel) || cleanOptions.length,
        options: cleanOptions,
      });
      onCreated(created);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Could not create modifier group');
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create modifier group"
      description="Groups let a customer choose options — Size, Add-ons, Spice level."
      height="full"
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} isLoading={saving}>
            {saving ? 'Creating…' : 'Create group'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="mg-name">
            Name<span className="text-danger" aria-hidden="true">*</span>
          </label>
          <Input
            id="mg-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Size"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="mg-sel">
              Selection
            </label>
            <Select
              id="mg-sel"
              value={selection}
              onChange={(e) => setSelection(e.target.value as 'SINGLE' | 'MULTIPLE')}
            >
              <option value="SINGLE">Single</option>
              <option value="MULTIPLE">Multiple</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="mg-min">
              Min selections
            </label>
            <Input
              id="mg-min"
              type="number"
              inputMode="numeric"
              min={0}
              value={minSel}
              onChange={(e) => setMinSel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="mg-max">
              Max selections
            </label>
            <Input
              id="mg-max"
              type="number"
              inputMode="numeric"
              min={1}
              value={maxSel}
              onChange={(e) => setMaxSel(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Options</span>
            <Button type="button" variant="outline" size="sm" onClick={addOption}>
              <Plus className="h-3.5 w-3.5" /> Add option
            </Button>
          </div>
          <ul className="space-y-2">
            {options.map((o) => (
              <li key={o.key} className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2">
                <Input
                  value={o.name}
                  onChange={(e) => patchOption(o.key, { name: e.target.value })}
                  placeholder="Option name (e.g. Large)"
                  aria-label="Option name"
                  className="flex-1"
                />
                <div className="relative w-28">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground">
                    LKR
                  </span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={o.priceDelta}
                    onChange={(e) => patchOption(o.key, { priceDelta: e.target.value })}
                    aria-label="Price delta"
                    className="pl-10"
                  />
                </div>
                {options.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeOption(o.key)}
                    className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                    aria-label="Remove option"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

// ── Card D: Recipe / components (D65) ────────────────────────────────────────

/**
 * The recipe a composed item consumes when a round is submitted (Phase 8).
 * One level, no nesting; wastage entered as a percentage. Persisted after
 * save via `PUT /products/:id/components` — replace-all, like modifiers.
 */
function RecipeCard({
  state,
  errors,
  session,
  onChange,
}: {
  state: WizardState;
  errors: Record<string, string>;
  session: Session;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const patchRow = (index: number, patch: Partial<ComponentDraft>) => {
    onChange({
      components: state.components.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  };
  const removeRow = (index: number) => {
    onChange({ components: state.components.filter((_, i) => i !== index) });
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
            <ListTree className="h-4 w-4 text-primary" aria-hidden="true" />
            Recipe / components
          </h3>
          <p className="text-xs text-muted-foreground">
            What one unit consumes from stock when a round is sent. Leave empty if stock
            isn&apos;t tracked for this item.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setPickerOpen(true)}
        >
          Add component
        </Button>
      </header>

      {state.components.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
          No components. Without a recipe this item moves no stock when ordered.
        </p>
      ) : (
        <ul className="space-y-2" role="group" aria-label="Recipe components">
          {state.components.map((c, ci) => (
            <li
              key={c.componentProductId}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.componentName}</p>
                {c.componentSku ? (
                  <p className="text-[11px] text-muted-foreground">{c.componentSku}</p>
                ) : null}
              </div>
              <div className="w-24">
                <Input
                  inputMode="decimal"
                  value={c.quantity}
                  onChange={(e) => patchRow(ci, { quantity: e.target.value })}
                  aria-label={`Quantity of ${c.componentName}`}
                  aria-invalid={!!errors[`component-qty-${ci}`]}
                  placeholder="Qty"
                />
              </div>
              <div className="relative w-24">
                <Input
                  inputMode="decimal"
                  value={c.wastagePercent}
                  onChange={(e) => patchRow(ci, { wastagePercent: e.target.value })}
                  aria-label={`Wastage percent for ${c.componentName}`}
                  aria-invalid={!!errors[`component-wastage-${ci}`]}
                  placeholder="Waste"
                  className="pr-7"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground">
                  %
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeRow(ci)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                aria-label={`Remove ${c.componentName}`}
              >
                <X className="h-4 w-4" />
              </button>
              {errors[`component-qty-${ci}`] ? (
                <p className="w-full text-xs text-danger" role="alert">
                  {errors[`component-qty-${ci}`]}
                </p>
              ) : null}
              {errors[`component-wastage-${ci}`] ? (
                <p className="w-full text-xs text-danger" role="alert">
                  {errors[`component-wastage-${ci}`]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {pickerOpen ? (
        <ProductSelectorDialog
          session={session}
          onBack={() => setPickerOpen(false)}
          onSelect={(product) => {
            setPickerOpen(false);
            // One row per component; picking an already-listed product is a
            // no-op rather than a duplicate the server would refuse.
            if (state.components.some((c) => c.componentProductId === product.id)) return;
            onChange({
              components: [
                ...state.components,
                {
                  componentProductId: product.id,
                  componentName: product.name,
                  componentSku: product.sku,
                  quantity: '1',
                  wastagePercent: '',
                },
              ],
            });
          }}
        />
      ) : null}
    </section>
  );
}

// ── Card B: Promotions / Offers ──────────────────────────────────────────────

function PromotionsCard({
  session,
  selectedIds,
  onChange,
}: {
  session: Session;
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const [promos, setPromos] = React.useState<Promotion[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPromotions(session, { isActive: true })
      .then((res) => {
        if (!cancelled) setPromos(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load promotions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const toggle = (id: string) => {
    onChange(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  };

  const openEditor = () => {
    // window.open (new tab) rather than router.push: the wizard is a long form
    // with a draft persisted in-memory only. Navigating within the same tab
    // would discard everything the operator has typed.
    if (typeof window !== 'undefined') {
      window.open('/products/promotions/new', '_blank', 'noopener');
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            Promotions & offers
          </h3>
          <p className="text-xs text-muted-foreground">
            Link this product to running promotions. Changes apply after Save.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
          onClick={openEditor}
        >
          Create new promotion
        </Button>
      </header>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" aria-hidden="true" />
          Loading promotions…
        </p>
      ) : error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : promos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
          No active promotions. Create one and it will show up here to link.
        </p>
      ) : (
        <ul className="space-y-1.5" role="group" aria-label="Promotions">
          {promos.map((p) => {
            const checked = selectedIds.includes(p.id);
            return (
              <li key={p.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={checked}
                    onChange={() => toggle(p.id)}
                    aria-label={`Link ${p.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {labelForPromotionType(p.type)}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {summarisePromotionSchedule(p)}
                    </p>
                  </div>
                  {checked ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Card C: Availability & Kitchen ───────────────────────────────────────────

function AvailabilityKitchenCard({
  state,
  session,
  branchId,
  onChange,
}: {
  state: WizardState;
  session: Session;
  branchId: string | null;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const { session: authSession } = useAuth();
  // Fall back to the auth session's branch if the shell didn't pass one — the
  // stations catalogue is branch-scoped, and picking the wrong branch here
  // would show an empty list even for tenants who do have stations.
  const effectiveBranchId = branchId ?? authSession?.branchId ?? null;

  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!effectiveBranchId) {
      setLoading(false);
      setStations([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    kitchenStationsApi
      .list(session, effectiveBranchId)
      .then((rows) => {
        if (!cancelled) setStations(rows.filter((s) => s.isActive));
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Could not load kitchen stations');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, effectiveBranchId]);

  const toggleStation = (id: string) => {
    onChange({
      kitchenStationIds: state.kitchenStationIds.includes(id)
        ? state.kitchenStationIds.filter((x) => x !== id)
        : [...state.kitchenStationIds, id],
    });
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header>
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
          <Utensils className="h-4 w-4 text-primary" aria-hidden="true" />
          Availability & kitchen
        </h3>
        <p className="text-xs text-muted-foreground">
          Which kitchen prepares it, and whether it is available to sell.
        </p>
      </header>

      {/* Active — the server defaults a fresh product to `isActive: true`, so
          the visual is an informational read-only cue rather than an editable
          switch (the operator deactivates from the Products list). Kept as an
          on-cue here per the brief. */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
        <Switch
          checked={true}
          onCheckedChange={() => undefined}
          disabled
          aria-label="Active"
        />
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Active</span> — new products are active on
          save. Deactivate later from the Products list.
        </div>
      </div>

      {/* Kitchen stations — multi-select. */}
      <div className="space-y-2">
        <span className="text-sm font-medium">Kitchen stations</span>
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" aria-hidden="true" />
            Loading stations…
          </p>
        ) : error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : stations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
            No active kitchen stations for the selected branch.
          </p>
        ) : (
          <ul className="space-y-1.5" role="group" aria-label="Kitchen stations">
            {stations.map((s) => {
              const checked = state.kitchenStationIds.includes(s.id);
              return (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={checked}
                      onChange={() => toggleStation(s.id)}
                      aria-label={`Route to ${s.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {s.code} · {s.category}
                      </p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Read-only summary of Step 1's prep time so the operator can verify. */}
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <Timer className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          Preparation time:{' '}
          <span className="font-medium text-foreground">
            {state.prepMinutes ? `${state.prepMinutes} min` : 'not set'}
          </span>{' '}
          — edit on Step 1 if needed.
        </span>
      </div>
    </section>
  );
}
