'use client';

import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import type { ModifierGroupDraft, ModifierOptionDraft, WizardState } from './wizard-state';

/**
 * Restaurant Menu Wizard — Step 3: Modifiers & availability.
 *
 * Modifier groups map to `ModifierGroup` + `ModifierOption`. Availability
 * toggle maps to `MenuItem.isActive`. Time-window availability (day-of-week /
 * start / end) is available on the wire but deferred to a follow-up UI so this
 * step stays focused.
 *
 * Each group is a collapsible card with name, required-toggle, allow-multiple
 * toggle, min/max, and option rows with priceDelta.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardState>) => void;
}

const emptyGroup = (): ModifierGroupDraft => ({
  key: `mg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  name: '',
  selection: 'MULTIPLE',
  minSelections: 0,
  maxSelections: 5,
  options: [emptyOption()],
  role: null,
});

const emptyOption = (): ModifierOptionDraft => ({
  key: `mo-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  name: '',
  priceDelta: 0,
});

export function StepModifiersAvailability({ state, errors, onChange }: Props) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    // Auto-expand any group that has errors so the operator sees the problem.
    const next = new Set(expanded);
    let changed = false;
    state.modifierGroups.forEach((g, gi) => {
      const hasError =
        errors[`mg-name-${gi}`] ||
        errors[`mg-opts-${gi}`] ||
        errors[`mg-max-${gi}`] ||
        errors[`mg-range-${gi}`] ||
        g.options.some((_, oi) => errors[`mo-name-${gi}-${oi}`]);
      if (hasError && !next.has(g.key)) {
        next.add(g.key);
        changed = true;
      }
    });
    if (changed) setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors]);

  const toggleExpanded = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addGroup = () => {
    const g = emptyGroup();
    onChange({ modifierGroups: [...state.modifierGroups, g] });
    setExpanded(new Set([...expanded, g.key]));
  };

  const updateGroup = (key: string, patch: Partial<ModifierGroupDraft>) => {
    onChange({
      modifierGroups: state.modifierGroups.map((g) => (g.key === key ? { ...g, ...patch } : g)),
    });
  };

  const removeGroup = (key: string) => {
    onChange({ modifierGroups: state.modifierGroups.filter((g) => g.key !== key) });
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 3 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Modifiers &amp; availability</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Configure extras, add-ons and whether this item is currently offered.
        </p>
      </div>

      {/* Availability */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
        <div>
          <label htmlFor="wiz-availability" className="text-sm font-medium">
            Available on menu
          </label>
          <p className="text-xs text-muted-foreground">
            When off, the item stays in the menu list but cashiers and diners cannot pick
            it. Historical orders and reports are unaffected.
          </p>
        </div>
        <Switch
          aria-label="Available on menu"
          checked={state.isActive}
          onCheckedChange={(v) => onChange({ isActive: v })}
        />
      </div>

      {/* Modifier groups */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Modifier groups</p>
            <p className="text-xs text-muted-foreground">
              Optional. Groups like Extras or Special Options each carry their own options
              and pricing.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={addGroup}
          >
            Add modifier group
          </Button>
        </div>

        {state.modifierGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No modifier groups yet. Diners will not be prompted for extras or special
            requests.
          </div>
        ) : (
          <ul className="space-y-2" role="list">
            {state.modifierGroups.map((g, gi) => {
              const isExpanded = expanded.has(g.key);
              const nameError = errors[`mg-name-${gi}`];
              const optsError = errors[`mg-opts-${gi}`];
              const rangeError = errors[`mg-range-${gi}`];
              const maxError = errors[`mg-max-${gi}`];
              return (
                <li
                  key={g.key}
                  className="animate-in fade-in rounded-xl border border-border bg-card"
                  style={{ animationDuration: '160ms' }}
                >
                  {/* Header row */}
                  <div className="flex items-center gap-2 p-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(g.key)}
                      aria-expanded={isExpanded}
                      aria-controls={`mg-body-${g.key}`}
                      className="flex flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="text-sm font-semibold">
                        {g.name || <span className="text-muted-foreground">Untitled group</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {g.options.length} option{g.options.length === 1 ? '' : 's'}
                        {' · '}
                        {g.minSelections > 0 ? 'Required' : 'Optional'}
                        {g.selection === 'MULTIPLE' ? ' · Multiple allowed' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeGroup(g.key)}
                      aria-label={`Remove ${g.name || 'group'}`}
                      // touch-target-coarse: on a tablet the trash icon sits
                      // right next to the group's collapse toggle — a 28px
                      // hit-slop is easy to fumble into the wrong action.
                      className="rounded-md p-2 text-muted-foreground transition-colors touch-target-coarse hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Body */}
                  {isExpanded ? (
                    <div id={`mg-body-${g.key}`} className="space-y-3 border-t border-border p-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label
                            htmlFor={`mg-name-${g.key}`}
                            className="text-xs font-medium"
                          >
                            Group name
                          </label>
                          <Input
                            id={`mg-name-${g.key}`}
                            value={g.name}
                            onChange={(e) => updateGroup(g.key, { name: e.target.value })}
                            placeholder="Extras"
                            maxLength={80}
                            aria-invalid={!!nameError}
                          />
                          {nameError ? (
                            <p className="text-[11px] text-danger" role="alert">
                              {nameError}
                            </p>
                          ) : null}
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-medium">Selection rule</p>
                          <div
                            role="radiogroup"
                            aria-label="Selection rule"
                            className="grid grid-cols-2 gap-2"
                          >
                            {(['SINGLE', 'MULTIPLE'] as const).map((sel) => {
                              const selected = g.selection === sel;
                              return (
                                <button
                                  key={sel}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  onClick={() =>
                                    updateGroup(g.key, {
                                      selection: sel,
                                      // SINGLE forces maxSelections=1 (server enforces).
                                      maxSelections:
                                        sel === 'SINGLE' ? 1 : Math.max(g.maxSelections, 1),
                                    })
                                  }
                                  // px-3 py-3 lifts the segmented options to
                                  // a real touch target on tablets — p-2 alone
                                  // was ~28px which is fingertip-sized only in
                                  // theory.
                                  className={`rounded-lg border px-3 py-3 text-xs font-medium transition-colors motion-reduce:transition-none ${
                                    selected
                                      ? 'border-primary bg-primary/10 text-primary'
                                      : 'border-border hover:border-primary'
                                  }`}
                                >
                                  {sel === 'SINGLE' ? 'Single-select' : 'Multi-select'}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={g.minSelections > 0}
                            onChange={(e) =>
                              updateGroup(g.key, { minSelections: e.target.checked ? 1 : 0 })
                            }
                            className="h-4 w-4 rounded border-border"
                          />
                          Required
                        </label>
                        <div className="space-y-1">
                          <label
                            htmlFor={`mg-min-${g.key}`}
                            className="text-[11px] font-medium text-muted-foreground"
                          >
                            Min
                          </label>
                          <Input
                            id={`mg-min-${g.key}`}
                            type="number"
                            min={0}
                            max={20}
                            value={String(g.minSelections)}
                            onChange={(e) =>
                              updateGroup(g.key, { minSelections: Number(e.target.value) || 0 })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <label
                            htmlFor={`mg-max-${g.key}`}
                            className="text-[11px] font-medium text-muted-foreground"
                          >
                            Max
                          </label>
                          <Input
                            id={`mg-max-${g.key}`}
                            type="number"
                            min={1}
                            max={20}
                            value={String(g.maxSelections)}
                            onChange={(e) =>
                              updateGroup(g.key, {
                                maxSelections: Number(e.target.value) || 1,
                              })
                            }
                            disabled={g.selection === 'SINGLE'}
                            aria-invalid={!!maxError}
                          />
                        </div>
                      </div>
                      {maxError ? (
                        <p className="text-[11px] text-danger" role="alert">
                          {maxError}
                        </p>
                      ) : null}
                      {rangeError ? (
                        <p className="text-[11px] text-danger" role="alert">
                          {rangeError}
                        </p>
                      ) : null}

                      {/* Options */}
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Options
                        </p>
                        {g.options.map((o, oi) => {
                          const oErr = errors[`mo-name-${gi}-${oi}`];
                          return (
                            <div
                              key={o.key}
                              className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_140px_auto]"
                            >
                              <div className="space-y-1">
                                <label className="sr-only" htmlFor={`mo-name-${o.key}`}>
                                  Option name
                                </label>
                                <Input
                                  id={`mo-name-${o.key}`}
                                  value={o.name}
                                  onChange={(e) =>
                                    updateGroup(g.key, {
                                      options: g.options.map((oo) =>
                                        oo.key === o.key ? { ...oo, name: e.target.value } : oo,
                                      ),
                                    })
                                  }
                                  placeholder="Extra chicken"
                                  maxLength={80}
                                  aria-invalid={!!oErr}
                                />
                                {oErr ? (
                                  <p className="text-[11px] text-danger" role="alert">
                                    {oErr}
                                  </p>
                                ) : null}
                              </div>
                              <div className="relative">
                                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                                  +LKR
                                </span>
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="0.01"
                                  value={String(o.priceDelta)}
                                  onChange={(e) =>
                                    updateGroup(g.key, {
                                      options: g.options.map((oo) =>
                                        oo.key === o.key
                                          ? { ...oo, priceDelta: Number(e.target.value) || 0 }
                                          : oo,
                                      ),
                                    })
                                  }
                                  className="pl-14"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  updateGroup(g.key, {
                                    options: g.options.filter((oo) => oo.key !== o.key),
                                  })
                                }
                                aria-label={`Remove ${o.name || 'option'}`}
                                // touch-target-coarse: option rows are dense —
                                // width-only h-11 wasn't a comfortable target
                                // on tablets. Coarse-only so the mouse footprint
                                // stays the same.
                                className="h-11 rounded-md px-2 text-muted-foreground touch-target-coarse hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          );
                        })}
                        {optsError ? (
                          <p className="text-[11px] text-danger" role="alert">
                            {optsError}
                          </p>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          leftIcon={<Plus className="h-4 w-4" />}
                          onClick={() =>
                            updateGroup(g.key, { options: [...g.options, emptyOption()] })
                          }
                        >
                          Add option
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
