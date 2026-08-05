'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, ArrowRight, ClipboardCheck, Save } from 'lucide-react';

import { PriceStockStep } from '@/components/products/wizard/price-stock-step';
import { ProductDetailsStep } from '@/components/products/wizard/product-details-step';
import {
  ProductWizardProgress,
  type ProgressItem,
} from '@/components/products/wizard/product-wizard-progress';
import { ReviewStep, type ReviewIssue } from '@/components/products/wizard/review-step';
import {
  initialFormState,
  numOrNull,
  type FieldErrors,
  type FormState,
  type StepKey,
  type StepStatus,
} from '@/components/products/wizard/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Session } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { resolveProductManagementPresentation } from '@/lib/products/product-presentation';
import { productDraftService } from '@/lib/product-draft';
import {
  createProduct,
  deleteProductImage,
  updateProduct,
  uploadProductImage,
  type CategoryNode,
  type ManagedProduct,
  type ProductInput,
} from '@/lib/products-api';

/** Three steps mirroring the QuickBooks Products & Services fields. */
const STEPS: StepKey[] = ['details', 'pricing', 'review'];
const STEP_LABELS: Record<StepKey, string> = {
  details: 'Product Details',
  pricing: 'Price & Stock',
  review: 'Review & Save',
};

export function ProductForm({
  session,
  categories,
  product,
  isAdmin,
}: {
  session: Session;
  categories: CategoryNode[];
  product?: ManagedProduct;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const editing = !!product;
  const productId = product?.id ?? null;

  const { inventoryMode } = useEffectiveProfile();
  const presentation = resolveProductManagementPresentation({
    inventoryMode,
    syncStatus: product?.syncStatus,
    quickbooksItemId: product?.quickbooksItemId ?? null,
  });

  const [form, setForm] = React.useState<FormState>(() => initialFormState(product));
  const [imageUrl, setImageUrl] = React.useState<string | null>(product?.imageUrl ?? null);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = React.useState<string | null>(null);
  const [imageBusy, setImageBusy] = React.useState(false);
  const [step, setStep] = React.useState<StepKey>('details');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const dirty = React.useRef(false);

  /**
   * Stock is read-only for a non-admin only where an external system owns it.
   *
   * Under LOCAL inventory AxloPOS *is* the authority, so there is nothing to defer
   * to and a cashier-facing lock would be inventing a restriction. The condition is
   * therefore gated on the mode, not just on the presence of an item id — which is
   * the client-controlled value this slice is not allowed to route on.
   */
  const qbManaged = presentation.showSyncActions && !!product?.quickbooksItemId;
  const stockLocked = qbManaged && !isAdmin;

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    dirty.current = true;
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const setCategory = React.useCallback((categoryId: string) => {
    dirty.current = true;
    setForm((f) => ({ ...f, categoryId, subcategoryId: '' }));
  }, []);

  React.useEffect(() => {
    return () => {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    };
  }, [pendingPreview]);

  // ---- image (POS-side photo; stored in S3, never sent to QuickBooks) ----
  const onPickFile = async (file: File) => {
    dirty.current = true;
    setError(null);
    if (editing && product) {
      setImageBusy(true);
      try {
        const updated = await uploadProductImage(session, product.id, file);
        setImageUrl(updated.imageUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Image upload failed');
      } finally {
        setImageBusy(false);
      }
    } else {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingFile(file);
      setPendingPreview(URL.createObjectURL(file));
    }
  };

  const onRemoveImage = async () => {
    dirty.current = true;
    setError(null);
    if (editing && product && imageUrl) {
      setImageBusy(true);
      try {
        await deleteProductImage(session, product.id);
        setImageUrl(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not remove image');
      } finally {
        setImageBusy(false);
      }
    } else {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingFile(null);
      setPendingPreview(null);
    }
  };

  const previewSrc = pendingPreview ?? imageUrl;

  // Restore a locally-saved draft (create mode only — edit mode trusts the server).
  React.useEffect(() => {
    if (editing) return;
    const draft = productDraftService.load(null);
    if (draft) {
      // Merge over defaults so drafts saved before new fields existed stay valid.
      setForm({ ...initialFormState(), ...draft.fields });
      setStep(draft.step >= 0 ? (STEPS[draft.step] ?? 'details') : 'details');
      setDraftSavedAt(draft.savedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const isLast = stepIndex === STEPS.length - 1;

  // ---- validation (only what the current step needs) ----
  const validate = React.useCallback(
    (key: StepKey): FieldErrors => {
      const e: FieldErrors = {};
      if (key === 'details') {
        if (!form.name.trim()) e.name = 'Please enter a product name before continuing.';
      }
      if (key === 'pricing') {
        if (form.unitPrice.trim() === '' || Number.isNaN(Number(form.unitPrice))) {
          e.unitPrice = 'Enter a valid selling price.';
        } else if (Number(form.unitPrice) < 0) {
          e.unitPrice = 'Price cannot be negative.';
        }
      }
      return e;
    },
    [form],
  );

  const stepStatus = React.useCallback(
    (key: StepKey): StepStatus => {
      if (key === step) return 'current';
      const idx = STEPS.indexOf(key);
      if (key === 'review') return 'todo';
      const errs = validate(key);
      if (Object.keys(errs).length > 0) return idx < stepIndex ? 'attention' : 'todo';
      return idx < stepIndex ? 'complete' : 'todo';
    },
    [step, validate, stepIndex],
  );

  // Furthest step the user may jump forward to.
  const maxReachable = React.useMemo(() => {
    let reach = 0;
    for (let i = 0; i < STEPS.length; i += 1) {
      reach = i;
      const s = stepStatus(STEPS[i]!);
      if (s !== 'complete' && s !== 'optional' && s !== 'current') break;
    }
    return Math.max(reach, stepIndex);
  }, [stepStatus, stepIndex]);

  const progressItems: ProgressItem[] = STEPS.map((key, i) => ({
    key,
    label: STEP_LABELS[key],
    status: stepStatus(key),
    clickable: i <= maxReachable,
  }));

  const goTo = (key: StepKey) => {
    const target = STEPS.indexOf(key);
    if (target < 0) return;
    if (target <= maxReachable) {
      setError(null);
      setStep(key);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const focusFirstError = () => {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
    }, 0);
  };

  const goNext = () => {
    const errs = validate(step);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      focusFirstError();
      return;
    }
    setErrors({});
    if (isLast) {
      void submit();
      return;
    }
    setStep(STEPS[stepIndex + 1]!);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goBack = () => {
    if (stepIndex <= 0) return;
    setError(null);
    setStep(STEPS[stepIndex - 1]!);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ---- draft (wizard progress, saved locally) ----
  const saveDraft = () => {
    const savedAt = productDraftService.save(productId, { fields: form, step: stepIndex });
    setDraftSavedAt(savedAt);
  };

  // ---- submit ----
  const buildInput = (): ProductInput => {
    const isInventory = form.type === 'Inventory';
    return {
      name: form.name.trim(),
      type: form.type,
      sku: form.sku.trim() || null,
      description: form.description.trim() || null,
      categoryId: form.categoryId || null,
      subcategoryId: form.subcategoryId || null,
      unitPrice: Number(form.unitPrice) || 0,
      purchaseDescription: form.purchaseDescription.trim() || null,
      costPrice: numOrNull(form.costPrice),
      quantityOnHand: isInventory ? Number(form.quantityOnHand) || 0 : 0,
      quantityAsOfDate: isInventory && form.quantityAsOfDate ? form.quantityAsOfDate : null,
      reorderLevel: isInventory ? numOrNull(form.reorderLevel) : null,
      isActive: form.isActive,
    };
  };

  const submit = async () => {
    const detailsErr = validate('details');
    const priceErr = validate('pricing');
    if (Object.keys(detailsErr).length) {
      setErrors(detailsErr);
      goTo('details');
      focusFirstError();
      return;
    }
    if (Object.keys(priceErr).length) {
      setErrors(priceErr);
      goTo('pricing');
      focusFirstError();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = buildInput();
      // Nothing tracks stock in this mode, so no quantity is submitted at all.
      // Sending one would record a figure the POS never enforces and the operator
      // would reasonably read as a promise.
      if (!presentation.showStockControls) {
        delete (input as Partial<ProductInput>).quantityOnHand;
        delete (input as Partial<ProductInput>).quantityAsOfDate;
        delete (input as Partial<ProductInput>).reorderLevel;
      }
      // Appended only when the resolver has mode-appropriate wording, so the
      // QuickBooks flow keeps its existing silent redirect.
      const saved = presentation.saveMessage ? '?saved=1' : '';
      if (editing && product) {
        if (stockLocked) delete (input as Partial<ProductInput>).quantityOnHand;
        await updateProduct(session, product.id, input);
        productDraftService.clear(productId);
        router.push(`/products/${product.id}${saved}`);
      } else {
        const created = await createProduct(session, input);
        productDraftService.clear(null);
        if (pendingFile) {
          try {
            await uploadProductImage(session, created.id, pendingFile);
          } catch {
            /* image can be added later from edit */
          }
        }
        router.push(`/products/${created.id}${saved}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save product');
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty.current) setConfirmCancel(true);
    else router.back();
  };

  // ---- derived summary/review data ----
  const category = categories.find((c) => c.id === form.categoryId) ?? null;
  const subcategory = category?.subcategories.find((s) => s.id === form.subcategoryId) ?? null;

  const reviewIssues: ReviewIssue[] = [];
  if (!form.name.trim()) reviewIssues.push({ label: 'Add a product name', step: 'details' });
  if (form.unitPrice.trim() === '' || Number.isNaN(Number(form.unitPrice)))
    reviewIssues.push({ label: 'Set a valid selling price', step: 'pricing' });

  const completedLabels: string[] = [];
  if (form.name.trim()) completedLabels.push('Product details complete');
  if (form.categoryId) completedLabels.push('Category selected');
  if (form.unitPrice.trim() !== '' && !Number.isNaN(Number(form.unitPrice)))
    completedLabels.push('Pricing complete');

  // Header status: how many required fields are still missing.
  const requiredRemaining =
    (form.name.trim() ? 0 : 1) +
    (form.unitPrice.trim() !== '' && !Number.isNaN(Number(form.unitPrice)) ? 0 : 1);

  const nextIsReview = !isLast && STEPS[stepIndex + 1] === 'review';
  const primaryLabel = isLast
    ? editing
      ? 'Save changes'
      : 'Create product'
    : nextIsReview
      ? 'Review product'
      : 'Continue';
  const primaryIcon = isLast ? (
    <Save className="h-4 w-4" />
  ) : nextIsReview ? (
    <ClipboardCheck className="h-4 w-4" />
  ) : (
    <ArrowRight className="h-4 w-4" />
  );

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 pb-28">
      {/* Header: title + compact status + 3-step progress */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {editing ? 'Edit product' : 'Add product'}
            </h1>
            <p className="text-sm text-muted-foreground">
              Step {stepIndex + 1} of {STEPS.length}
              {requiredRemaining > 0 ? (
                <>
                  {' · '}
                  <span className="text-warning">
                    {requiredRemaining} required field{requiredRemaining === 1 ? '' : 's'} remaining
                  </span>
                </>
              ) : (
                <>
                  {' · '}
                  <span className="text-success">Ready to review</span>
                </>
              )}
            </p>
          </div>
          <Badge variant={editing ? (form.isActive ? 'success' : 'neutral') : 'primary'}>
            {editing ? (form.isActive ? 'Active' : 'Inactive') : 'New'}
          </Badge>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-2 shadow-sm">
          <ProductWizardProgress items={progressItems} current={step} onStep={goTo} />
        </div>
      </div>

      {/* Single-column step content. */}
      <div className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        {step === 'details' ? (
          <ProductDetailsStep
            presentation={presentation}
            form={form}
            set={set}
            setCategory={setCategory}
            errors={errors}
            categories={categories}
            imageSrc={previewSrc}
            imageBusy={imageBusy}
            onPickFile={(f) => void onPickFile(f)}
            onRemoveImage={() => void onRemoveImage()}
          />
        ) : null}
        {step === 'pricing' ? (
          <PriceStockStep
            form={form}
            set={set}
            errors={errors}
            stockLocked={stockLocked}
            product={product}
            presentation={presentation}
          />
        ) : null}
        {step === 'review' ? (
          <ReviewStep
            form={form}
            categoryName={category?.name ?? null}
            subcategoryName={subcategory?.name ?? null}
            completed={completedLabels}
            issues={reviewIssues}
            onGoTo={goTo}
            stepLabel={`Step ${stepIndex + 1} of ${STEPS.length}`}
          />
        ) : null}
      </div>

      {/* Single sticky action bar controls the whole flow. */}
      <div className="sticky bottom-0 z-30 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-[0_-4px_12px_rgba(15,23,42,0.05)] backdrop-blur">
        {error ? <p className="mb-2 text-sm text-danger">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={stepIndex === 0 ? cancel : goBack}>
              <ArrowLeft className="h-4 w-4" /> {stepIndex === 0 ? 'Cancel' : 'Back'}
            </Button>
            {!editing ? (
              <Button variant="outline" onClick={saveDraft}>
                Save draft
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {draftSavedAt ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">Draft saved</span>
            ) : null}
            <Button
              size="lg"
              onClick={goNext}
              isLoading={saving}
              disabled={saving}
              rightIcon={saving ? undefined : primaryIcon}
            >
              {primaryLabel}
            </Button>
          </div>
        </div>
      </div>

      {/* Cancel confirmation */}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Discard changes?"
        description="You have unsaved changes on this product."
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
          Tip: use <strong>Save draft</strong> to keep your progress before leaving.
        </p>
      </Dialog>
    </div>
  );
}
