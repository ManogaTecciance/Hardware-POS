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
import { resolveProductManagementPresentation } from '@/lib/products/product-presentation';
import {
  createProduct,
  fetchCategoryTree,
  updateProduct,
  type CategoryNode,
  type ManagedProduct,
} from '@/lib/products-api';
import { fetchBranches, type BranchSummary } from '@/lib/products/branches-api';
import {
  createVariantsBatch,
  fetchVariants,
  fetchVariations,
  putVariations,
  updateVariant,
  type ProductVariant,
  type ProductVariationDimension,
} from '@/lib/products/variants-api';

import { ProductPreview } from './product-preview';
import { StepDetails } from './step-details';
import { StepPricingInventory } from './step-pricing-inventory';
import { StepReview } from './step-review';
import { StepVariations } from './step-variations';
import { Stepper } from './stepper';
import {
  buildCreateInput,
  buildVariantsBatchInput,
  buildVariationsPayload,
  hydrateFromProduct,
  initialState,
  STEP_ORDER,
  validateStep,
  type StepKey,
  type WizardState,
} from './wizard-state';

// Steps declared once here so the stepper and the switch below cannot disagree
// about ordering or labels.
const WIZARD_STEPS: { index: number; key: StepKey; label: string }[] = [
  { index: 0, key: 'details', label: 'Product details' },
  { index: 1, key: 'variations', label: 'Variations' },
  { index: 2, key: 'pricing', label: 'Pricing & inventory' },
  { index: 3, key: 'review', label: 'Review & save' },
];

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
  const { inventoryMode } = useEffectiveProfile();
  const presentation = resolveProductManagementPresentation({
    inventoryMode,
    syncStatus: mode === 'edit' ? props.initialProduct.syncStatus : undefined,
    quickbooksItemId: mode === 'edit' ? props.initialProduct.quickbooksItemId : null,
  });
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
  const [dimensions, setDimensions] = React.useState<ProductVariationDimension[]>([]);
  const [originalVariants, setOriginalVariants] = React.useState<ProductVariant[]>([]);
  const [loading, setLoading] = React.useState(mode === 'edit');
  const [stepIndex, setStepIndex] = React.useState(0);
  const [stepAnimKey, setStepAnimKey] = React.useState(0);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
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

  // Load categories (if not passed) and branches on mount.
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [cats, brs] = await Promise.all([
        props.categories && props.categories.length > 0
          ? Promise.resolve(props.categories)
          : fetchCategoryTree(session).catch(() => [] as CategoryNode[]),
        fetchBranches(session).catch(() => [] as BranchSummary[]),
      ]);
      if (cancelled) return;
      setCategories(cats);
      setBranches(brs);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, props.categories]);

  // Edit-mode hydration — variants + dimensions come from separate endpoints.
  React.useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [variantsRes, dimsRes] = await Promise.all([
          fetchVariants(session, props.initialProductId).catch(() => [] as ProductVariant[]),
          fetchVariations(session, props.initialProductId).catch(() => ({ dimensions: [] })),
        ]);
        if (cancelled) return;
        setDimensions(dimsRes.dimensions);
        setOriginalVariants(variantsRes);
        setState(hydrateFromProduct(props.initialProduct, variantsRes, dimsRes.dimensions));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // A stable id is enough; the object identity of `initialProduct` doesn't matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, mode, mode === 'edit' ? props.initialProductId : null]);

  const patchState = React.useCallback((patch: Partial<WizardState>) => {
    dirty.current = true;
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const currentStep = WIZARD_STEPS[stepIndex]!.key;

  const goTo = (nextIndex: number) => {
    setStepIndex(nextIndex);
    setStepAnimKey((k) => k + 1);
    setErrors({});
    setSaveError(null);
  };

  const onContinue = () => {
    const stepErrors = validateStep(currentStep, state, { inventoryMode });
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    if (stepIndex < WIZARD_STEPS.length - 1) {
      goTo(stepIndex + 1);
    }
  };

  const onBack = () => {
    if (stepIndex === 0) {
      if (dirty.current) setConfirmCancel(true);
      else router.back();
      return;
    }
    goTo(stepIndex - 1);
  };

  const onEditFrom = (target: StepKey) => {
    const nextIndex = STEP_ORDER.indexOf(target);
    if (nextIndex >= 0) goTo(nextIndex);
  };

  // ── Persistence ──────────────────────────────────────────────────────────

  const persist = async () => {
    // Final validation across every step; the earliest failure wins the focus.
    const allErrors: Record<string, string> = {};
    for (const key of STEP_ORDER.filter((s) => s !== 'review')) {
      Object.assign(allErrors, validateStep(key, state, { inventoryMode }));
    }
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      const earliest = STEP_ORDER.find(
        (k) => Object.keys(validateStep(k, state, { inventoryMode })).length > 0,
      );
      if (earliest) goTo(STEP_ORDER.indexOf(earliest));
      return;
    }

    setSaveState('saving');
    setSaveError(null);
    try {
      if (mode === 'create') {
        await runCreate(session, state, patchStateAfterCreate);
      } else {
        await runEdit(session, props.initialProductId, state, originalVariants);
      }
      setSaveState('saved');
      setToast(mode === 'edit' ? 'Product updated.' : 'Product created.');
      const id = mode === 'edit' ? props.initialProductId : (lastCreatedIdRef.current ?? '');
      // Brief pause so the toast is visible before the route change lands.
      setTimeout(() => {
        if (id) router.push(`/products/${id}`);
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

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2.6fr)_minmax(280px,1fr)]">
      <div className="space-y-5">
        <Stepper steps={WIZARD_STEPS} currentIndex={stepIndex} onStepClick={goTo} />

        <div
          key={stepAnimKey}
          className="animate-in fade-in slide-in-from-top-1 rounded-2xl border border-border bg-card p-5 motion-reduce:animate-none"
          style={{ animationDuration: '160ms' }}
        >
          {currentStep === 'details' ? (
            <StepDetails
              state={state}
              errors={errors}
              categories={categories}
              session={session}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'variations' ? (
            <StepVariations state={state} errors={errors} onChange={patchState} />
          ) : null}
          {currentStep === 'pricing' ? (
            <StepPricingInventory
              state={state}
              errors={errors}
              branches={branches}
              showOpeningStock={showOpeningStock}
              onChange={patchState}
            />
          ) : null}
          {currentStep === 'review' ? (
            <StepReview
              state={state}
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
        <div className="min-w-0 lg:min-w-[280px]">
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
  setCreatedId: (id: string) => void,
): Promise<void> {
  const input = buildCreateInput(state, state.imageUrl || null);
  // Discard fields the platform-profile hides — the server accepts them but
  // sending them from a UI that pretends they don't exist is misleading.
  const created = await createProduct(session, input);
  setCreatedId(created.id);

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
 * Edit-path submit. Deliberately narrower than create — the wizard does NOT
 * add or remove variants in edit mode (that's the Product Details page).
 * Instead: PATCH the parent, PUT the variations if the shape changed, then
 * PATCH each variant whose fields drifted from the hydrated original.
 */
async function runEdit(
  session: Session,
  productId: string,
  state: WizardState,
  originalVariants: ProductVariant[],
): Promise<void> {
  const input = buildCreateInput(state, state.imageUrl || null);
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
