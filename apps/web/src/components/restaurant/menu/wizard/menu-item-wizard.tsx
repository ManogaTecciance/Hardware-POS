'use client';

import { ArrowLeft, ArrowRight, Eye, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Toast } from '@/components/ui/toast';
import { type Session } from '@/lib/auth';
import { useIsDesktop } from '@/lib/use-viewport';
import {
  kitchenStations as stationsApi,
  menuItems as menuItemsApi,
  menuSections as sectionsApi,
  menus as menusApi,
  modifierGroups as modifiersApi,
} from '@/lib/restaurant/api';
import type {
  KitchenStationView,
  MenuView,
  ModifierGroupView,
  SectionView,
} from '@/lib/restaurant/types';

import { ItemPreview } from './item-preview';
import { Stepper } from './stepper';
import { StepMenuDetails } from './step-menu-details';
import { StepModifiersAvailability } from './step-modifiers-availability';
import { StepPricingVariations } from './step-pricing-variations';
import { StepReviewSave } from './step-review-save';
import {
  emptyWizardState,
  hydrateWizardState,
  validateStep,
  type ModifierGroupDraft,
  type WizardState,
} from './wizard-state';

const WIZARD_STEPS = [
  { index: 1, label: 'Menu details', detail: 'Name, section, type, image' },
  { index: 2, label: 'Pricing & variations', detail: 'Base price + sizes' },
  { index: 3, label: 'Modifiers & availability', detail: 'Extras + toggle' },
  { index: 4, label: 'Review & save', detail: 'Verify and publish' },
] as const;

interface Props {
  session: Session;
  branchId: string;
  mode: 'create' | 'edit';
  /** Only used in create mode as a preselection. */
  initialSectionId?: string;
  /** Only used in edit mode. */
  editingItemId?: string;
}

/**
 * Restaurant Menu Item Wizard — the 4-step form used for both create and edit
 * ("Do not create a separate Edit UI" — brief §EDIT MENU ITEM FLOW).
 *
 * Fetches menu / section / station / modifier catalogues on mount, hydrates
 * from the existing item in edit mode, and persists on Save via:
 *
 *   1. Upsert the SIZE modifier group if variations are present.
 *   2. Create each new plain modifier group; update existing ones.
 *   3. Create or PATCH the MenuItem with the collected group ids.
 *
 * On success routes back to /menu with a bottom-centre toast.
 */
export function MenuItemWizard({ session, branchId, mode, initialSectionId, editingItemId }: Props) {
  const router = useRouter();

  const [menus, setMenus] = React.useState<MenuView[]>([]);
  const [sections, setSections] = React.useState<SectionView[]>([]);
  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [modifierGroups, setModifierGroups] = React.useState<ModifierGroupView[]>([]);

  const [state, setState] = React.useState<WizardState>(() => emptyWizardState(initialSectionId ?? null));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [stepAnimKey, setStepAnimKey] = React.useState(0);
  // Preview rail becomes an on-demand Sheet on tablet-and-narrower — the
  // rail's 280–380px width squeezes the form badly in iPad landscape, and
  // the form + rail cannot both be visible at all on portrait. Desktop
  // keeps the inline rail unchanged.
  const isDesktop = useIsDesktop();
  const [previewOpen, setPreviewOpen] = React.useState(false);

  const canManage = true; // Route guard enforced upstream on /menu.

  // Load catalogues (+ item for edit).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [menuRows, stationRows, modifierRows] = await Promise.all([
          menusApi.list(session, branchId, false),
          stationsApi.list(session, branchId, false).catch(() => [] as KitchenStationView[]),
          modifiersApi.list(session, false).catch(() => [] as ModifierGroupView[]),
        ]);
        if (cancelled) return;
        setMenus(menuRows);
        setStations(stationRows);
        setModifierGroups(modifierRows);

        // Sections across all menus for this branch — the wizard's Section select.
        const sectionResults = await Promise.all(
          menuRows.map((m) => sectionsApi.list(session, m.id).catch(() => [] as SectionView[])),
        );
        if (cancelled) return;
        const allSections = sectionResults.flat();
        setSections(allSections);

        // Edit mode — hydrate from the item once catalogues are loaded so we
        // can look up its SIZE group.
        if (mode === 'edit' && editingItemId) {
          // Need to fetch the item; the section index is unknown so we scan.
          // A dedicated `GET /menu-items/:id` would be cleaner — noted as a
          // follow-up. For now: iterate sections until found.
          let found = null;
          for (const s of allSections) {
            const items = await menuItemsApi.list(session, s.id, true).catch(() => []);
            const hit = items.find((i) => i.id === editingItemId);
            if (hit) {
              found = hit;
              break;
            }
          }
          if (!cancelled && found) {
            setState(hydrateWizardState(found, modifierRows));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, branchId, mode, editingItemId]);

  const patchState = React.useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const goToStep = (step: 1 | 2 | 3 | 4) => {
    setState((prev) => ({ ...prev, currentStep: step }));
    setStepAnimKey((k) => k + 1);
    setErrors({});
  };

  const onContinue = () => {
    const stepErrors = validateStep(state.currentStep as 1 | 2 | 3 | 4, state);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    if (state.currentStep < 4) {
      goToStep(((state.currentStep + 1) as 1 | 2 | 3 | 4));
    }
  };

  const onBack = () => {
    if (state.currentStep === 1) {
      router.push('/menu');
      return;
    }
    goToStep(((state.currentStep - 1) as 1 | 2 | 3 | 4));
  };

  const persist = async () => {
    // Final validation across all steps.
    const allErrors = {
      ...validateStep(1, state),
      ...validateStep(2, state),
      ...validateStep(3, state),
    };
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      // Jump to the earliest step with an error.
      const earliest = Object.keys(allErrors).some((k) => ['name', 'sectionId', 'itemType', 'prepMinutes'].includes(k))
        ? 1
        : Object.keys(allErrors).some((k) => k.startsWith('basePrice') || k.startsWith('variation-'))
          ? 2
          : 3;
      goToStep(earliest as 1 | 2 | 3);
      return;
    }
    if (!state.sectionId) return; // guarded above; satisfies TS

    setSaving(true);
    setSaveError(null);
    try {
      const modifierGroupIds: string[] = [];

      // 1) SIZE modifier group — from the variations rows.
      if (state.variations.length > 0) {
        const sizeGroupName = `${state.name.trim()} — Size`;
        const sizeOptions = state.variations.map((v, i) => ({
          name: v.name.trim(),
          priceDelta: Number(v.priceDelta) || 0,
          position: i,
        }));
        const existingSize = modifierGroups.find(
          (g) => g.role === 'SIZE' && state.editingItemId
            ? state.name && g.name === sizeGroupName
            : false,
        );
        if (existingSize) {
          const updated = await modifiersApi.update(session, existingSize.id, {
            name: sizeGroupName,
            selection: 'SINGLE',
            minSelections: 1,
            maxSelections: 1,
            options: sizeOptions,
            role: 'SIZE',
          });
          modifierGroupIds.push(updated.id);
        } else {
          const created = await modifiersApi.create(session, {
            name: sizeGroupName,
            selection: 'SINGLE',
            minSelections: 1,
            maxSelections: 1,
            options: sizeOptions,
            role: 'SIZE',
          });
          modifierGroupIds.push(created.id);
        }
      }

      // 2) Plain modifier groups.
      for (const g of state.modifierGroups) {
        const groupName = g.name.trim();
        const payload = {
          name: groupName,
          selection: g.selection,
          minSelections: g.minSelections,
          maxSelections: g.maxSelections,
          options: g.options.map((o, i) => ({
            name: o.name.trim(),
            priceDelta: Number(o.priceDelta) || 0,
            position: i,
          })),
        };
        if (g.serverId) {
          const updated = await modifiersApi.update(session, g.serverId, payload);
          modifierGroupIds.push(updated.id);
        } else {
          const created = await modifiersApi.create(session, payload);
          modifierGroupIds.push(created.id);
        }
      }

      // 3) MenuItem itself.
      const commonBody = {
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        basePrice: Number(state.basePrice) || 0,
        itemType: state.itemType ?? undefined,
        prepMinutes: state.prepMinutes ? Number(state.prepMinutes) : undefined,
        dietaryTags: state.dietaryTags,
        imageUrl: state.imageUrl.trim() || undefined,
        modifierGroupIds,
        stationIds: state.stationId ? [state.stationId] : [],
      };

      if (state.editingItemId) {
        await menuItemsApi.update(session, state.sectionId, state.editingItemId, {
          ...commonBody,
          isActive: state.isActive,
        });
      } else {
        const created = await menuItemsApi.create(session, state.sectionId, commonBody);
        if (!state.isActive) {
          await menuItemsApi.update(session, state.sectionId, created.id, { isActive: false });
        }
      }

      setToast(
        state.editingItemId
          ? `${state.name.trim()} updated.`
          : `${state.name.trim()} added to the menu.`,
      );
      // Brief pause so the operator sees the toast before route change.
      setTimeout(() => router.push('/menu'), 400);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save menu item');
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
        Loading catalogue…
      </div>
    );
  }

  const step = state.currentStep as 1 | 2 | 3 | 4;
  const currentSection = sections.find((s) => s.id === state.sectionId);
  const currentStation = stations.find((s) => s.id === state.stationId);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2.6fr)_minmax(280px,1fr)]">
      {/* Main column: header + stepper + step body + footer */}
      <div className="space-y-5">
        <Stepper steps={[...WIZARD_STEPS]} currentStep={step} onStepClick={(i) => goToStep(i as 1 | 2 | 3 | 4)} />

        <div
          key={stepAnimKey}
          className="animate-in fade-in slide-in-from-top-1 rounded-2xl border border-border bg-card p-5"
          style={{ animationDuration: '160ms' }}
        >
          {step === 1 ? (
            <StepMenuDetails
              state={state}
              errors={errors}
              sections={sections}
              stations={stations}
              session={session}
              onChange={patchState}
            />
          ) : null}
          {step === 2 ? (
            <StepPricingVariations state={state} errors={errors} onChange={patchState} />
          ) : null}
          {step === 3 ? (
            <StepModifiersAvailability state={state} errors={errors} onChange={patchState} />
          ) : null}
          {step === 4 ? (
            <StepReviewSave
              state={state}
              sections={sections}
              stations={stations}
              onEdit={(s) => goToStep(s)}
            />
          ) : null}
        </div>

        {saveError ? (
          <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
            {saveError}
          </p>
        ) : null}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
          <Button
            type="button"
            variant="ghost"
            leftIcon={<ArrowLeft className="h-4 w-4" />}
            onClick={onBack}
            disabled={saving}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>

          {/* Preview trigger — on `<lg` viewports only. Desktop already
              shows the rail inline; a duplicate trigger there would be
              redundant and could confuse the operator into thinking two
              previews exist. `lg:hidden` handles the visual hide; the DOM
              stays predictable and no hydration flash. */}
          <Button
            type="button"
            variant="outline"
            leftIcon={<Eye className="h-4 w-4" />}
            onClick={() => setPreviewOpen(true)}
            disabled={saving}
            className="lg:hidden"
          >
            Preview
          </Button>

          {step < 4 ? (
            <Button
              type="button"
              onClick={onContinue}
              rightIcon={<ArrowRight className="h-4 w-4" />}
              disabled={saving}
            >
              Continue
            </Button>
          ) : (
            <Button type="button" onClick={persist} isLoading={saving} disabled={!canManage}>
              {state.editingItemId ? 'Save changes' : 'Save menu item'}
            </Button>
          )}
        </div>
      </div>

      {/* Preview rail — desktop only. On tablet-and-narrower the Sheet
          below carries the same component; mounting one at a time avoids
          a duplicate second-render of the same state graph. */}
      {isDesktop ? (
        <div className="min-w-0 lg:min-w-[280px]">
          <ItemPreview
            state={state}
            sectionName={currentSection?.name ?? null}
            stationName={currentStation?.name ?? null}
          />
        </div>
      ) : null}

      {/* On-demand preview Sheet — bottom-anchored so an operator with the
          tablet flat on a bench can reach the panel without lifting a hand.
          Reuses `<ItemPreview>` unchanged so the mock and the sheet cannot
          drift out of sync. */}
      <Sheet
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        height="full"
        title="Live preview"
        description="How this item will appear on the POS and menu."
      >
        <ItemPreview
          state={state}
          sectionName={currentSection?.name ?? null}
          stationName={currentStation?.name ?? null}
        />
      </Sheet>

      {/* Menus map for section-column context. Kept invisible until useful. */}
      <span className="sr-only" aria-hidden="true">
        {menus.length} menus loaded
      </span>

      {toast ? <Toast message={toast} tone="success" /> : null}
    </div>
  );
}
