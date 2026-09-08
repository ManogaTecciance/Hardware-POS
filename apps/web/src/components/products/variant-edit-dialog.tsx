'use client';

import { Loader2, Save } from 'lucide-react';
import * as React from 'react';

import { ImageUpload } from '@/components/products/wizard/image-upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { type Session } from '@/lib/auth';
import {
  updateVariant,
  uploadVariantImage,
  type ProductVariant,
  type ProductVariationDimension,
} from '@/lib/products/variants-api';

/**
 * Variant edit dialog (D44).
 *
 * Only the fields the backend PATCH endpoint accepts: SKU, barcode, selling
 * price, cost price, reorder point, image, and active flag. Anything that
 * would rewrite history (weighted-average cost, past receipts) is deliberately
 * absent — the server refuses those and the UI should not pretend otherwise.
 *
 * The variant's option combination is shown read-only near the top so the
 * operator knows exactly which row they are editing before typing anything.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  session: Session;
  productId: string;
  variant: ProductVariant | null;
  variations: ProductVariationDimension[];
  onSaved: (updated: ProductVariant) => void;
}

/**
 * Compose the human-readable option combination — "200ml · Glass Bottle" —
 * from the variant's option values. Falls back to SKU when a variant carries
 * no option values (a single-variant product edited from the tabbed page).
 */
function optionCombinationLabel(v: ProductVariant): string {
  const parts = v.optionValues.map((o) => o.optionName).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : v.sku;
}

export function VariantEditDialog({
  open,
  onClose,
  session,
  productId,
  variant,
  onSaved,
}: Props) {
  const [sku, setSku] = React.useState('');
  const [barcode, setBarcode] = React.useState('');
  const [unitPrice, setUnitPrice] = React.useState('');
  const [costPrice, setCostPrice] = React.useState('');
  const [reorderLevel, setReorderLevel] = React.useState('');
  const [imageUrl, setImageUrl] = React.useState('');
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [isActive, setIsActive] = React.useState(true);
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  // Rehydrate from the incoming variant every time the dialog is opened; a
  // stale form after switching variants would silently rewrite the wrong row.
  React.useEffect(() => {
    if (!open || !variant) return;
    setSku(variant.sku ?? '');
    setBarcode(variant.barcode ?? '');
    setUnitPrice(String(variant.unitPrice));
    setCostPrice(variant.costPrice != null ? String(variant.costPrice) : '');
    setReorderLevel(variant.reorderLevel != null ? String(variant.reorderLevel) : '');
    setImageUrl(variant.imageUrl ?? '');
    setImageFile(null);
    setIsActive(variant.isActive);
    setSaveState('idle');
    setError(null);
  }, [open, variant]);

  if (!variant) return null;

  const canSubmit =
    saveState !== 'saving' && sku.trim().length > 0 && Number(unitPrice) >= 0 && unitPrice.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaveState('saving');
    setError(null);

    try {
      // Build a minimal PATCH — every diff is expressed as an explicit field so
      // an untouched barcode does not become `null` by accident.
      const patch: Parameters<typeof updateVariant>[3] = {
        sku: sku.trim(),
        barcode: barcode.trim() || null,
        unitPrice: Number(unitPrice),
        costPrice: costPrice.trim() ? Number(costPrice) : null,
        reorderLevel: reorderLevel.trim() ? Number(reorderLevel) : null,
        imageUrl: imageUrl.trim() || null,
        isActive,
      };

      let updated = await updateVariant(session, productId, variant.id, patch);

      // Image upload runs AFTER the field patch so a failed image save does not
      // discard the successful text edits. On success, its response is the new
      // canonical variant.
      if (imageFile) {
        updated = await uploadVariantImage(session, productId, variant.id, imageFile);
      }

      setSaveState('saved');
      setTimeout(() => {
        onSaved(updated);
        onClose();
      }, 350);
    } catch (err) {
      setSaveState('idle');
      setError(err instanceof Error ? err.message : 'Could not save variant');
    }
  };

  // Sheet's footer sits outside the form's DOM tree, so a submit button in
  // the footer has to use the `form=…` attribute to target this form —
  // otherwise the click would not submit anything.
  const FORM_ID = 'variant-edit-form';

  return (
    // Sheet, not Dialog: on a tablet the old 448px Dialog crammed SKU +
    // Barcode + two LKR inputs + image upload into one column, forcing
    // scrolling before the operator could even see the Save button. Sheet
    // is bottom-anchored (fingertips already there), full-width on
    // portrait, and capped on desktop so it still reads as a modal card.
    <Sheet
      open={open}
      onClose={saveState === 'saving' ? () => undefined : onClose}
      title="Edit variant"
      description="Selling price, stock and identity fields. Weighted-average cost is maintained by the server and cannot be overwritten here."
      // lg:max-w-xl overrides Sheet's default `tab:max-w-2xl` at desktop
      // width — a variant edit form is short enough that 576px reads as
      // a proper modal card, not a pane that fills half the screen.
      className="lg:max-w-xl"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={saveState === 'saving'}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            // `form=…` submits the form even though this button lives in
            // the Sheet's footer, outside the form's DOM subtree.
            form={FORM_ID}
            disabled={!canSubmit || saveState === 'saved'}
            leftIcon={
              saveState === 'saving' ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Save className="h-4 w-4" />
              )
            }
          >
            {saveState === 'saving'
              ? 'Saving...'
              : saveState === 'saved'
                ? 'Saved'
                : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-border bg-muted/40 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Editing</p>
          <p className="mt-0.5 text-sm font-medium">{optionCombinationLabel(variant)}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ve-sku">SKU</Label>
            <Input
              id="ve-sku"
              type="text"
              required
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="mt-1"
              maxLength={64}
            />
          </div>

          <div>
            <Label htmlFor="ve-barcode">Barcode</Label>
            <Input
              id="ve-barcode"
              type="text"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="Optional"
              className="mt-1"
              maxLength={64}
            />
          </div>

          <div>
            <Label htmlFor="ve-price">Selling price</Label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                LKR
              </span>
              <Input
                id="ve-price"
                type="number"
                step="0.01"
                min="0"
                required
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                // touch-manipulation kills double-tap-to-zoom on iOS —
                // Numeric inputs get double-tapped by accident all the time
                // when the operator's finger hovers to type.
                className="pl-12 touch-manipulation"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="ve-cost">Cost price</Label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                LKR
              </span>
              <Input
                id="ve-cost"
                type="number"
                step="0.01"
                min="0"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                placeholder="Optional"
                className="pl-12 touch-manipulation"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="ve-reorder">Reorder point</Label>
            <Input
              id="ve-reorder"
              type="number"
              step="1"
              min="0"
              value={reorderLevel}
              onChange={(e) => setReorderLevel(e.target.value)}
              placeholder="Optional"
              className="mt-1 touch-manipulation"
            />
          </div>

          <div className="flex flex-col justify-end">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <div>
                <p className="text-sm font-medium" id="ve-active-label">
                  Variant is active
                </p>
                <p className="text-xs text-muted-foreground">
                  Inactive variants stay hidden on the POS.
                </p>
              </div>
              <Switch
                aria-labelledby="ve-active-label"
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={saveState === 'saving'}
              />
            </div>
          </div>

          <div className="sm:col-span-2">
            <Label>Variant image</Label>
            <div className="mt-1">
              {/* Reuses the wizard's ImageUpload wholesale — the endpoint the
                  uploader targets is pre-create only, so we intercept `File`s
                  here and defer the real upload to updateVariant's sibling
                  `uploadVariantImage`. Pasting a URL still flows through as an
                  `imageUrl` PATCH. */}
              <ImageUpload
                session={session}
                value={imageFile ? URL.createObjectURL(imageFile) : imageUrl}
                onChange={(next) => {
                  setImageUrl(next);
                  setImageFile(null);
                }}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Uploads and URLs both save with the variant.
              </p>
            </div>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
