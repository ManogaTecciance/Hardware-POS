'use client';

import { ArrowLeft, ArrowRight, Eye, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Sheet } from '@/components/ui/sheet';
import { Toast } from '@/components/ui/toast';
import { type Session } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { useIsDesktop } from '@/lib/use-viewport';
import {
  resolveBusinessKind,
  resolveMeasuredGoods,
  resolveProductManagementPresentation,
} from '@/lib/products/product-presentation';
import {
  createProduct,
  fetchCategoryTree,
  updateProduct,
  type CategoryNode,
  type ManagedProduct,
} from '@/lib/products-api';
import { fetchBranches, type BranchSummary } from '@/lib/products/branches-api';
import { createReceipt } from '@/lib/products/receipts-api';
import {
  fetchAttributeLibrary,
  type AttributeDefinition as LibraryAttribute,
} from '@/lib/products/attribute-library-api';
import {
  fetchProductModifierGroups,
  putProductModifierGroups,
} from '@/lib/products/product-modifiers-api';
import {
  fetchProductComponents,
  putProductComponents,
} from '@/lib/products/components-api';
import {
  fetchProductStations,
  putProductStations,
} from '@/lib/products/product-stations-api';
import {
  defaultRoleForPromotionType,
  fetchPromotion,
  fetchPromotions,
  updatePromotion,
} from '@/lib/products/promotions-api';
import {
  createVariantsBatch,
  fetchVariants,
  fetchVariations,
  putVariations,
  updateVariant,
  type ProductVariant,
  type ProductVariationDimension,
} from '@/lib/products/variants-api';

import {
  fetchProductAttributeSchema,
  type AttributeField,
} from '@/lib/products/attributes-api';

import { ProductPreview } from './product-preview';
import { StepAttributes } from './step-attributes';
import { fetchSettings } from '@/lib/settings-api';

import { StepDetails } from './step-details';
import { StepPricingInventory } from './step-pricing-inventory';
import { StepReview } from './step-review';
import { StepVariations } from './step-variations';
import { Stepper } from './stepper';
import {
  buildComponentsPayload,
  buildCreateInput,
  buildOpeningReceiptInput,
  buildVariantsBatchInput,
  buildVariationsPayload,
  hydrateFromProduct,
  initialState,
  STEP_ORDER,
  validateStep,
  visibleSteps,
  type StepKey,
  type WizardState,
} from './wizard-state';

// Labels declared once here so the stepper and the switch below cannot
// disagree. The step LIST is computed per-tenant: the attributes step (D64)
// only exists for domains whose attribute schema declares fields.
const STEP_LABELS: Record<StepKey, string> = {
  details: 'Product details',
  attributes: 'Business details',
  variations: 'Variations',
  pricing: 'Pricing & inventory',
  review: 'Review & save',
};

interface CreateProps {
  mode: 'create';
  session: Session;
  categories?: CategoryNode[];
}

interface EditProps {
  mode: 'edit';
  session: Session;
  categories?: CategoryNode[];
  initialProductId: string;
  initialProduct: ManagedProduct;
}

type Props = CreateProps | EditProps;

/**
 * Add / Edit Product wizard (D44).
 *
 * Owns:
 *   • Wizard state and step navigation.
 *   • Category and branch catalogue fetches (accepts a `categories` prop when
 *     the parent already has one loaded — avoids the extra round-trip on the
 *     Add flow).
 *   • The four-step submit sequence: product image → product create/patch →
 *     variations PUT → variants:batch. Each hop stays within one round-trip
 *     the wizard can present as either "saved" or a single actionable error.
 */
export function ProductWizard(props: Props) {
  const { session, mode } = props;
  const router = useRouter();
  const { inventoryMode, profile } = useEffectiveProfile();
  const presentation = resolveProductManagementPresentation({
    inventoryMode,
    syncStatus: mode === 'edit' ? props.initialProduct.syncStatus : undefined,
    quickbooksItemId: mode === 'edit' ? props.initialProduct.quickbooksItemId : null,
  });
  // Restaurant vs. Retail. The step components must not compare `businessType`
  // themselves (D31 — the resolver is the single authority), so the shell
  // derives it once here and passes it as a prop.
  const businessKind = resolveBusinessKind(profile?.businessType ?? null);
  /*
   * D134e — weighed goods are RETAIL-only, and `businessKind` cannot say so:
   * its `RETAIL` bucket includes hardware. Resolved from the capability here,
   * beside the kind, so Step 3 takes a flag rather than a business type.
   */
  const showMeasuredGoods = resolveMeasuredGoods(profile?.businessType ?? null);
  /*
   * 3.15 — the tenant's tax rate, so the Taxable toggle can name the number it
   * turns on instead of saying "this shop's configured rate".
   *
   * Fetched by the SHELL and passed down, the same way `businessKind` and
   * `showRecipe` are: a step component that fetched its own settings would be
   * the scattered lookup D31 exists to end.
   *
   * `null` means UNRESOLVED and is its own state — while it is loading, or if
   * the request fails, the toggle keeps its original wording rather than
   * asserting a rate it does not have. Never defaulted to 0, which would read
   * as "this shop charges no tax" and be a lie on every taxed tenant.
   */
  const [taxRatePercent, setTaxRatePercent] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!session) return;
    let active = true;
    fetchSettings(session)
      .then((s) => active && setTaxRatePercent(s.taxRatePercent))
      .catch(() => active && setTaxRatePercent(null));
    return () => {
      active = false;
    };
  }, [session]);
  // D65 — the recipe card exists only for tenants whose capabilities declare
  // it. Unresolved profile → no card, same fail-safe as everything else.
  const showRecipe = profile?.capabilities.catalogue.components === true;
  // `showOpeningStock` gates the opening-stock column, the branch select, and
  // the "opening stock only on LOCAL" info banner in Step 3. Reading it from
  // the resolver's `managementMode` — not from `inventoryMode` — keeps D31's
  // "no product component compares an inventory mode itself" rule intact: the
  // resolver is the single authority on which management mode this tenant is
  // in, and every component works off its classification.
  const showOpeningStock = presentation.managementMode === 'LOCAL';

  const [state, setState] = React.useState<WizardState>(() =>
    mode === 'edit' ? initialState() : initialState(),
  );
  const [categories, setCategories] = React.useState<CategoryNode[]>(props.categories ?? []);
  const [branches, setBranches] = React.useState<BranchSummary[]>([]);
  /*
   * D125 — the tenant's attribute library, so Step 2 can offer the scales an
   * operator has already defined instead of asking them to retype "Size" and
   * "Small" on every product. Fetched by the SHELL and passed down, the same
   * way `branches` and the attribute schema are.
   *
   * Failure is empty, not fatal: the step falls back to the free-text fields
   * it has always had, so a tenant with no library — or an API that is having
   * a bad minute — can still build a product.
   */
  const [attributeLibrary, setAttributeLibrary] = React.useState<LibraryAttribute[]>([]);
  // D64 — [] until resolved (and on fetch failure): the safe default is no
  // attributes step, mirroring the profile's unresolved-shows-nothing rule.
  const [attributeSchema, setAttributeSchema] = React.useState<readonly AttributeField[]>([]);
  const [dimensions, setDimensions] = React.useState<ProductVariationDimension[]>([]);
  const [originalVariants, setOriginalVariants] = React.useState<ProductVariant[]>([]);
  const [loading, setLoading] = React.useState(mode === 'edit');
  const [stepIndex, setStepIndex] = React.useState(0);
  const [stepAnimKey, setStepAnimKey] = React.useState(0);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  /**
   * Has this step been submitted yet?
   *
   * Errors appear on the first blocked Continue, never while the operator is
   * still filling the step in — but once shown they must track the state, or a
   * corrected field keeps its red message until Continue is pressed again and
   * the operator is left arguing with a stale complaint.
   */
  const [attempted, setAttempted] = React.useState(false);
  /**
   * Bumped ONLY by a blocked submit. The scroll/focus effect keys on this
   * rather than on `errors`, which now changes on every keystroke — otherwise
   * typing in one field would yank the page to another.
   */
  const [submitTick, setSubmitTick] = React.useState(0);
  /** Scroll/focus root for the validation effect below. */
  const stepRef = React.useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const dirty = React.useRef(false);
  // Preview rail becomes an on-demand Sheet on `<lg` viewports — a 280–380px
  // rail on iPad landscape squeezes the form badly, and the rail cannot
  // both fit alongside the form on portrait tablets at all. Desktop keeps
  // the inline rail unchanged.
  const isDesktop = useIsDesktop();
  const [previewOpen, setPreviewOpen] = React.useState(false);

  // D101 — a restaurant CREATE starts with stock untracked: dishes are the
  // common case, and the D44 default (true) belongs to retail. Flips once
  // when the profile resolves, and never after the operator touches the
  // form — their answer outranks the default.
  React.useEffect(() => {
    if (mode !== 'create' || businessKind !== 'RESTAURANT' || dirty.current) return;
    setState((prev) => (prev.trackInventory ? { ...prev, trackInventory: false } : prev));
  }, [mode, businessKind]);

  // Load categories (if not passed) and branches on mount.
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [cats, brs, attrs, library] = await Promise.all([
        props.categories && props.categories.length > 0
          ? Promise.resolve(props.categories)
          : fetchCategoryTree(session).catch(() => [] as CategoryNode[]),
        fetchBranches(session).catch(() => [] as BranchSummary[]),
        fetchProductAttributeSchema(session).catch(() => ({ fields: [] as AttributeField[] })),
        fetchAttributeLibrary(session).catch(() => [] as LibraryAttribute[]),
      ]);
      if (cancelled) return;
      setCategories(cats);
      setBranches(brs);
      setAttributeSchema(attrs.fields);
      setAttributeLibrary(library);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, props.categories]);

  // Edit-mode hydration — variants + dimensions come from separate endpoints.
  // Restaurant tenants also pull modifier-groups / stations / promotions to
  // preselect the check-lists on Step 3. Every extra fetch is defensively
  // cast to `.catch(() => defaultShape)` so a single 404 does not blank the
  // whole wizard.
  React.useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    setLoading(true);
    const isRestaurantEdit = businessKind === 'RESTAURANT';
    (async () => {
      try {
        const [variantsRes, dimsRes, mgRes, ksRes, promoRes, compRes] = await Promise.all([
          fetchVariants(session, props.initialProductId).catch(() => [] as ProductVariant[]),
          fetchVariations(session, props.initialProductId).catch(() => ({ dimensions: [] })),
          isRestaurantEdit
            ? fetchProductModifierGroups(session, props.initialProductId).catch(() => ({
                modifierGroups: [],
              }))
            : Promise.resolve({ modifierGroups: [] }),
          isRestaurantEdit
            ? fetchProductStations(session, props.initialProductId).catch(() => ({ stations: [] }))
            : Promise.resolve({ stations: [] }),
          isRestaurantEdit
            ? fetchPromotions(session, { productId: props.initialProductId }).catch(() => ({
                items: [],
                total: 0,
              }))
            : Promise.resolve({ items: [], total: 0 }),
          // D65 — the recipe. Restaurant-gated like its siblings; the card
          // itself is additionally capability-gated at render.
          isRestaurantEdit
            ? fetchProductComponents(session, props.initialProductId).catch(() => ({
                components: [],
              }))
            : Promise.resolve({ components: [] }),
        ]);
        if (cancelled) return;
        setDimensions(dimsRes.dimensions);
        setOriginalVariants(variantsRes);
        setState(
          hydrateFromProduct(props.initialProduct, variantsRes, dimsRes.dimensions, {
            modifierGroupIds: mgRes.modifierGroups.map((g) => g.id),
            kitchenStationIds: ksRes.stations.map((s) => s.id),
            promotionIds: promoRes.items.map((p) => p.id),
            components: compRes.components.map((c) => ({
              componentProductId: c.componentProductId,
              componentName: c.componentName,
              componentSku: c.componentSku,
              quantity: c.quantity,
              // API stores a 0–1 rate; the card edits a percentage.
              wastagePercent:
                Number(c.wastageRate) > 0 ? String(Number(c.wastageRate) * 100) : '',
            })),
          }),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // A stable id is enough; the object identity of `initialProduct` doesn't matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, mode, businessKind, mode === 'edit' ? props.initialProductId : null]);

  const patchState = React.useCallback((patch: Partial<WizardState>) => {
    dirty.current = true;
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // D64 — the visible step list is per-tenant data. Recomputed when the
  // schema lands; index-addressed state below always goes through this list.
  const wizardSteps = React.useMemo(
    () =>
      visibleSteps(attributeSchema).map((stepKey, index) => ({
        index,
        key: stepKey,
        label: STEP_LABELS[stepKey],
      })),
    [attributeSchema],
  );
  const currentStep = wizardSteps[Math.min(stepIndex, wizardSteps.length - 1)]!.key;
  const validateCtx = { inventoryMode, businessKind, attributeSchema };

  /**
   * `keepErrors` exists for one caller: Save on the Review step, which jumps
   * back to the earliest failing step and must ARRIVE with the messages
   * showing. Navigating normally still clears them — errors belong to the step
   * you were on, not the one you moved to.
   */
  const goTo = (nextIndex: number, { keepErrors = false }: { keepErrors?: boolean } = {}) => {
    setStepIndex(nextIndex);
    setStepAnimKey((k) => k + 1);
    if (!keepErrors) setErrors({});
    // A step reached normally starts clean; one reached BECAUSE it failed
    // arrives already submitted, so its messages keep tracking the fixes.
    setAttempted(keepErrors);
    setSaveError(null);
  };

  const onContinue = () => {
    const stepErrors = validateStep(currentStep, state, validateCtx);
    setAttempted(true);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      setSubmitTick((t) => t + 1);
      return;
    }
    if (stepIndex < wizardSteps.length - 1) {
      goTo(stepIndex + 1);
    }
  };

  /**
   * Bring the first failed field into view whenever validation blocks a move.
   *
   * Step 3 on a restaurant tenant runs well past one screen (modifiers,
   * promotions, kitchen routing, recipe), so a message rendered near the top
   * left the operator pressing Continue and watching nothing happen. A real
   * input is preferred because it can take focus — the next keystroke then
   * lands where the fix is needed — and the step-level alerts that have no
   * input of their own (`variations-empty`, `pricing-none-enabled`) are the
   * fallback. `scrollIntoView` is feature-checked: jsdom does not implement it.
   */
  React.useEffect(() => {
    if (submitTick === 0) return;
    const root = stepRef.current;
    if (!root) return;
    const field = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = field ?? root.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    field?.focus({ preventScroll: true });
  }, [submitTick]);

  /**
   * Once a step has been submitted, its errors follow the state.
   *
   * Without this the map is a snapshot from the moment Continue was pressed:
   * the operator corrects the field, the message stays put, and the only way
   * to find out whether it worked is to press Continue again. Re-running the
   * SAME validator the shell submits with keeps the two from disagreeing.
   */
  React.useEffect(() => {
    if (!attempted) return;
    setErrors(validateStep(currentStep, state, { inventoryMode, businessKind, attributeSchema }));
  }, [attempted, state, currentStep, inventoryMode, businessKind, attributeSchema]);

  const onBack = () => {
    if (stepIndex === 0) {
      if (dirty.current) setConfirmCancel(true);
      else router.back();
      return;
    }
    goTo(stepIndex - 1);
  };

  const onEditFrom = (target: StepKey, options?: { keepErrors?: boolean }) => {
    // Index into the VISIBLE list, not STEP_ORDER — they differ when the
    // attributes step is present (D64).
    const nextIndex = wizardSteps.findIndex((s) => s.key === target);
    if (nextIndex >= 0) goTo(nextIndex, options);
  };

  // ── Persistence ──────────────────────────────────────────────────────────

  const persist = async () => {
    // Final validation across every step; the earliest failure wins the focus.
    const allErrors: Record<string, string> = {};
    for (const key of STEP_ORDER.filter((s) => s !== 'review')) {
      Object.assign(allErrors, validateStep(key, state, validateCtx));
    }
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      const earliest = STEP_ORDER.find(
        (k) => Object.keys(validateStep(k, state, validateCtx)).length > 0,
      );
      // Both state updates batch, so a plain `goTo` here would land on the
      // failing step having just erased the errors it was sent to show.
      if (earliest) onEditFrom(earliest, { keepErrors: true });
      setSubmitTick((t) => t + 1);
      return;
    }

    setSaveState('saving');
    setSaveError(null);
    try {
      if (mode === 'create') {
        await runCreate(session, state, attributeSchema, patchStateAfterCreate);
      } else {
        await runEdit(session, props.initialProductId, state, attributeSchema, originalVariants);
      }
      // Restaurant links: after the product exists and variants are batched,
      // patch modifier-group + station links + promotion memberships. Kept
      // outside `runCreate`/`runEdit` so a partial failure here does not roll
      // back the product itself — the toast is degraded and the operator
      // fixes it from Products / Promotions admin. Retail wizards skip this
      // entirely (empty arrays short-circuit each call).
      const productId =
        mode === 'edit' ? props.initialProductId : (lastCreatedIdRef.current ?? '');
      let linkNote: string | null = null;
      if (productId && businessKind === 'RESTAURANT') {
        linkNote = await persistRestaurantLinks(session, productId, state, {
          // D65 — PUT the recipe only for capability-declaring tenants; in
          // edit mode an empty list is a deliberate clear, on create it is
          // a wasted call.
          putComponents: showRecipe && (state.components.length > 0 || mode === 'edit'),
        });
      }

      setSaveState('saved');
      if (linkNote) {
        setToast(linkNote);
      } else {
        setToast(mode === 'edit' ? 'Product updated.' : 'Product created.');
      }
      // Brief pause so the toast is visible before the route change lands.
      setTimeout(() => {
        if (productId) router.push(`/products/${productId}`);
      }, 400);
    } catch (err) {
      setSaveState('idle');
      setSaveError(err instanceof Error ? err.message : 'Could not save product');
    }
  };

  const lastCreatedIdRef = React.useRef<string | null>(null);
  const patchStateAfterCreate = (id: string) => {
    lastCreatedIdRef.current = id;
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
        Loading product...
      </div>
    );
  }

  /*
   * D159 — ONE step counter, computed from the step list.
   *
   * Four of the five steps hardcoded "Step N of 4". D150 added Business
   * details as a fifth and gave only the new step a computed label, so
   * every other panel has been reading "of 4" under a five-dot stepper
   * ever since. The list is per-tenant (the attributes step exists only
   * where the domain declares fields), so a literal cannot be right for
   * everyone in any case.
   */
  const positionLabel = `Step ${stepIndex + 1} of ${wizardSteps.length}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2.6fr)_minmax(280px,1fr)]">
      <div className="space-y-5">
        <Stepper steps={wizardSteps} currentIndex={stepIndex} onStepClick={goTo} />

        <div
          key={stepAnimKey}
          ref={stepRef}
          className="animate-in fade-in slide-in-from-top-1 rounded-2xl border border-border bg-card p-5 motion-reduce:animate-none"
          style={{ animationDuration: '160ms' }}
        >
          {currentStep === 'details' ? (
            <StepDetails
              state={state}
              errors={errors}
              positionLabel={positionLabel}
              categories={categories}
              session={session}
              businessKind={businessKind}
              taxRatePercent={taxRatePercent}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'attributes' ? (
            <StepAttributes
              state={state}
              errors={errors}
              schema={attributeSchema}
              positionLabel={positionLabel}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'variations' ? (
            <StepVariations
              state={state}
              errors={errors}
              positionLabel={positionLabel}
              attributeLibrary={attributeLibrary}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'pricing' ? (
            <StepPricingInventory
              state={state}
              errors={errors}
              positionLabel={positionLabel}
              branches={branches}
              showOpeningStock={showOpeningStock}
              showMeasuredGoods={showMeasuredGoods}
              businessKind={businessKind}
              session={session}
              branchId={session.branchId}
              showRecipe={showRecipe}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'review' ? (
            <StepReview
              state={state}
              positionLabel={positionLabel}
              categories={categories}
              showOpeningStock={showOpeningStock}
              saveState={saveState}
              onEdit={onEditFrom}
              onSave={() => void persist()}
            />
          ) : null}
        </div>

        {saveError ? (
          <p
            className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
            role="alert"
          >
            {saveError}
          </p>
        ) : null}

        {presentation.warning ? (
          <p className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
            {presentation.warning}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
          <Button
            type="button"
            variant="ghost"
            leftIcon={<ArrowLeft className="h-4 w-4" />}
            onClick={onBack}
            disabled={saveState === 'saving'}
          >
            {stepIndex === 0 ? 'Cancel' : 'Back'}
          </Button>

          {/* Preview trigger — `<lg` only. Desktop already carries the
              inline rail; two entry points into the same preview would be
              confusing there. `lg:hidden` handles the visual gate; the
              button always mounts so no hydration flash on tablet. */}
          <Button
            type="button"
            variant="outline"
            leftIcon={<Eye className="h-4 w-4" />}
            onClick={() => setPreviewOpen(true)}
            disabled={saveState === 'saving'}
            className="lg:hidden"
          >
            Preview
          </Button>

          {currentStep === 'review' ? (
            <span className="text-xs text-muted-foreground">
              Use the Save Product button above to finish.
            </span>
          ) : (
            <Button
              type="button"
              onClick={onContinue}
              rightIcon={<ArrowRight className="h-4 w-4" />}
              disabled={saveState === 'saving'}
            >
              Continue
            </Button>
          )}
        </div>
      </div>

      {/* Preview rail — desktop only. On tablet the Sheet below carries
          the same component; mounting one at a time keeps state graph
          rerenders unambiguous and avoids duplicate DOM. */}
      {isDesktop ? (
        // Testid so the tablet e2e can assert the rail is NOT mounted here
        // without matching the identical preview inside the Sheet.
        <div data-testid="product-preview-rail" className="min-w-0 lg:min-w-[280px]">
          <ProductPreview state={state} categories={categories} currentStepIndex={stepIndex} />
        </div>
      ) : null}

      {/* On-demand preview Sheet — bottom-anchored so the operator's thumb
          reaches the panel with the tablet on a bench. Reuses
          `<ProductPreview>` unchanged so the mock and the sheet cannot
          drift out of sync. */}
      <Sheet
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        height="full"
        title="Live preview"
        description="Reflects what you've entered so far."
      >
        <ProductPreview state={state} categories={categories} currentStepIndex={stepIndex} />
      </Sheet>

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Discard changes?"
        description="You have unsaved changes to this product."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => router.back()}>
              Discard &amp; leave
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Nothing is saved until the wizard&apos;s final step.
        </p>
      </Dialog>

      {toast ? <Toast message={toast} tone="success" /> : null}
    </div>
  );
}

// ── Create + Edit orchestration ──────────────────────────────────────────────

/**
 * Create-path submit. Serialised because each step's output feeds the next:
 * the product id (from POST /products) is required for the variations PUT,
 * whose response supplies real dimension/option ids for the variants:batch.
 */
async function runCreate(
  session: Session,
  state: WizardState,
  attributeSchema: readonly AttributeField[],
  setCreatedId: (id: string) => void,
): Promise<void> {
  const input = buildCreateInput(state, state.imageUrl || null, attributeSchema);
  // Discard fields the platform-profile hides — the server accepts them but
  // sending them from a UI that pretends they don't exist is misleading.
  const created = await createProduct(session, input);
  setCreatedId(created.id);

  /*
   * D159 — opening stock for a SINGLE product.
   *
   * It had nowhere to go before this. `ProductCreatePayload` has no
   * `quantityOnHand` field at all, so the number the operator typed was
   * validated, shown on the Review step as "Opening stock", and then
   * dropped — `buildCreateInput` was structurally incapable of sending it,
   * and never had.
   *
   * Posted as a receipt rather than added to the create payload for the
   * reason `buildOpeningReceiptInput` records: it is the path the variant
   * half already takes and the path every later GRN takes, so branch stock,
   * the Purchases tab and the weighted-average all follow from it.
   *
   * A SECOND call, not part of the create: `POST /products` writes no
   * inventory, and making it do so would change an endpoint hardware and
   * restaurant share. The variants path below is already serialised this
   * way for the same reason.
   */
  const opening = buildOpeningReceiptInput(state, created.id);
  if (opening) {
    await createReceipt(session, {
      ...opening,
      // The server upserts on `(tenantId, idempotencyKey)`, so a retry
      // after a network wobble cannot receive the same opening stock twice.
      idempotencyKey: `opening-${created.id}`,
    });
  }

  if (!state.hasVariations) return;

  const varsResponse = await putVariations(
    session,
    created.id,
    buildVariationsPayload(state),
  );

  // Remap client keys → server ids by matching NAME (the same discriminator
  // the server upserts on). Names are enforced unique per parent by the DTO
  // decorators, so there is exactly one match per key.
  const dimIdByKey = new Map<string, string>();
  const optIdByKey = new Map<string, string>();
  for (const d of state.variations) {
    const dimHit = varsResponse.dimensions.find((x) => x.name === d.name.trim());
    if (!dimHit) continue;
    dimIdByKey.set(d.key, dimHit.id);
    for (const o of d.options) {
      const optHit = dimHit.options.find((x) => x.name === o.name.trim());
      if (optHit) optIdByKey.set(o.key, optHit.id);
    }
  }

  const enabledCount = state.variants.filter((v) => v.enabled).length;
  if (enabledCount === 0) return;
  await createVariantsBatch(
    session,
    created.id,
    buildVariantsBatchInput(state, dimIdByKey, optIdByKey),
  );
}

/**
 * Restaurant link persistence (D45 — post-create/post-edit).
 *
 * Runs after the product itself is safely written. Deliberately isolated from
 * `runCreate`/`runEdit` so a partial failure here does NOT roll back the
 * product — the operator can complete the linking from the Products /
 * Promotions admin. Returns a degraded toast message on partial failure, or
 * `null` when everything landed cleanly (caller picks the default success
 * wording in that case).
 *
 * Promotions are updated in parallel because they are independent PATCHes;
 * modifier-groups and stations are the wizard's own PUT-replacements and
 * always run first so the failure surface is limited to "the promotion links
 * didn't stick" when it happens.
 */
async function persistRestaurantLinks(
  session: Session,
  productId: string,
  state: WizardState,
  options: { putComponents: boolean },
): Promise<string | null> {
  const modifierPromise =
    state.modifierGroupIds.length > 0 || state.hasVariations /* empty PUT is safe */
      ? putProductModifierGroups(session, productId, state.modifierGroupIds).catch(() => null)
      : Promise.resolve(null);
  const stationPromise =
    state.kitchenStationIds.length > 0
      ? putProductStations(session, productId, state.kitchenStationIds).catch(() => null)
      : Promise.resolve(null);
  // D65 — replace-all recipe PUT, same degrade-to-toast policy as the others.
  const componentsPromise = options.putComponents
    ? putProductComponents(session, productId, buildComponentsPayload(state)).catch(() => null)
    : Promise.resolve(null);

  const [mgResult, ksResult, compResult] = await Promise.all([
    modifierPromise,
    stationPromise,
    componentsPromise,
  ]);

  // Promotion links — fetch each promotion, add the new product to its item
  // list (if not already there), and PATCH. Parallel because they don't
  // depend on each other; the count of failures is summarised into the toast.
  let promoFailures = 0;
  if (state.promotionIds.length > 0) {
    const results = await Promise.all(
      state.promotionIds.map(async (promotionId) => {
        try {
          const promo = await fetchPromotion(session, promotionId);
          // Idempotent: if this product is already an item on the promotion
          // (edit mode re-save), skip the PATCH so we don't stack duplicate
          // PromotionItems on every save.
          if (promo.items.some((i) => i.productId === productId)) return true;
          const role = defaultRoleForPromotionType(promo.type);
          await updatePromotion(session, promotionId, {
            name: promo.name,
            description: promo.description,
            fixedPrice: promo.fixedPrice,
            percentageOff: promo.percentageOff,
            amountOff: promo.amountOff,
            buyQuantity: promo.buyQuantity,
            getQuantity: promo.getQuantity,
            startsOn: promo.startsOn,
            endsOn: promo.endsOn,
            daysOfWeek: promo.daysOfWeek,
            startTime: promo.startTime,
            endTime: promo.endTime,
            branchScope: promo.branchScope,
            channelScope: promo.channelScope,
            stackable: promo.stackable,
            items: [
              ...promo.items.map((i) => ({
                productId: i.productId,
                role: i.role,
                quantity: i.quantity,
              })),
              { productId, role, quantity: 1 },
            ],
          });
          return true;
        } catch {
          return false;
        }
      }),
    );
    promoFailures = results.filter((ok) => !ok).length;
  }

  const linkFailures =
    (mgResult === null && state.modifierGroupIds.length > 0 ? 1 : 0) +
    (ksResult === null && state.kitchenStationIds.length > 0 ? 1 : 0) +
    (compResult === null && options.putComponents ? 1 : 0);

  if (promoFailures > 0 && linkFailures === 0) {
    return `Product saved, but ${promoFailures} promotion link${
      promoFailures === 1 ? '' : 's'
    } failed.`;
  }
  if (linkFailures > 0) {
    return 'Product saved, but some kitchen or modifier links failed. Retry from the Products list.';
  }
  return null;
}

/**
 * Edit-path submit. Deliberately narrower than create — the wizard does NOT
 * add or remove variants in edit mode (that's the Product Details page).
 * Instead: PATCH the parent, PUT the variations if the shape changed, then
 * PATCH each variant whose fields drifted from the hydrated original.
 */
async function runEdit(
  session: Session,
  productId: string,
  state: WizardState,
  attributeSchema: readonly AttributeField[],
  originalVariants: ProductVariant[],
): Promise<void> {
  const input = buildCreateInput(state, state.imageUrl || null, attributeSchema);
  await updateProduct(session, productId, input);

  if (!state.hasVariations) return;

  // PUT variations even in edit mode: the server refuses to delete an option
  // that is still bound to a variant, so this converges the tree safely and
  // the operator gets a real error only when they actually try to drop an in-
  // use option.
  await putVariations(session, productId, buildVariationsPayload(state));

  const originalById = new Map(originalVariants.map((v) => [v.id, v]));
  for (const draft of state.variants) {
    if (!draft.serverId) continue; // wizard doesn't create new variants in edit mode
    const orig = originalById.get(draft.serverId);
    if (!orig) continue;
    const patch: Record<string, unknown> = {};
    if (draft.sku.trim() !== orig.sku) patch.sku = draft.sku.trim();
    const barcode = draft.barcode.trim() || null;
    if (barcode !== orig.barcode) patch.barcode = barcode;
    const unitPrice = Number(draft.unitPrice);
    if (Number.isFinite(unitPrice) && unitPrice !== orig.unitPrice) patch.unitPrice = unitPrice;
    const costPrice = draft.costPrice ? Number(draft.costPrice) : null;
    if ((costPrice ?? null) !== (orig.costPrice ?? null)) patch.costPrice = costPrice;
    const reorderLevel = draft.reorderLevel ? Number(draft.reorderLevel) : null;
    if ((reorderLevel ?? null) !== (orig.reorderLevel ?? null)) {
      patch.reorderLevel = reorderLevel;
    }
    if (draft.enabled !== orig.isActive) patch.isActive = draft.enabled;
    if (Object.keys(patch).length > 0) {
      await updateVariant(session, productId, draft.serverId, patch);
    }
  }
}
