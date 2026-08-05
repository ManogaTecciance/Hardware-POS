'use client';

import Link from 'next/link';
import { ImagePlus, Loader2, Settings2, Trash2, UploadCloud } from 'lucide-react';
import * as React from 'react';

import { ProductImage } from '@/components/product-image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ProductPresentation } from '@/lib/products/product-presentation';
import type { CategoryNode } from '@/lib/products-api';
import type { ProductItemType } from '@/lib/products-api';
import { cn } from '@/lib/utils';

import { Field, StepHeader } from './fields';
import type { FieldErrors, FormState, SetField } from './types';

const ITEM_TYPES: { value: ProductItemType; label: string; hint: string }[] = [
  { value: 'Inventory', label: 'Inventory', hint: 'Physical products you track quantities of.' },
  {
    value: 'NonInventory',
    label: 'Non-Inventory',
    hint: "Physical products you don't need to track quantities of.",
  },
  { value: 'Service', label: 'Service', hint: 'Professional services your business offers.' },
];

/**
 * Step 1 — the identity half of the QuickBooks Products & Services template:
 * name, item type, SKU, category, and sales description. The field set is the same
 * for every tenant; only the copy that names QuickBooks varies, and that comes from
 * the presentation resolver rather than a conditional here.
 */
export function ProductDetailsStep({
  form,
  set,
  setCategory,
  errors,
  categories,
  imageSrc,
  imageBusy,
  onPickFile,
  onRemoveImage,
  presentation,
}: {
  form: FormState;
  set: SetField;
  setCategory: (categoryId: string) => void;
  errors: FieldErrors;
  categories: CategoryNode[];
  imageSrc: string | null;
  imageBusy: boolean;
  onPickFile: (file: File) => void;
  onRemoveImage: () => void;
  /** Mode-aware copy; this step names QuickBooks only where QuickBooks applies. */
  presentation: ProductPresentation;
}) {
  const subcategories = categories.find((c) => c.id === form.categoryId)?.subcategories ?? [];
  const typeHint = ITEM_TYPES.find((t) => t.value === form.type)?.hint;
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onPickFile(f);
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow="Step 1 of 3"
        title="Product details"
        description={presentation.detailsHelpText}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Product/service name"
          htmlFor="field-name"
          required
          error={errors.name}
          className="sm:col-span-2"
        >
          <Input
            id="field-name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Glazed Ceramic Wall Tile 9122LT"
            aria-invalid={!!errors.name || undefined}
            aria-describedby={errors.name ? 'field-name-error' : undefined}
          />
        </Field>

        <Field
          label="Item type"
          htmlFor="field-type"
          help="Inventory tracks stock. Non-Inventory is for untracked goods. Service has no stock at all."
          hint={typeHint}
        >
          <Select
            id="field-type"
            value={form.type}
            onChange={(e) => set('type', e.target.value as ProductItemType)}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="SKU"
          htmlFor="field-sku"
          help="A string of numbers and letters unique to each item."
        >
          <Input
            id="field-sku"
            value={form.sku}
            onChange={(e) => set('sku', e.target.value)}
            placeholder="e.g. RJ-1"
          />
        </Field>

        <Field label="Category" htmlFor="field-category">
          <Select
            id="field-category"
            value={form.categoryId}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Subcategory" htmlFor="field-subcategory">
          <Select
            id="field-subcategory"
            value={form.subcategoryId}
            onChange={(e) => set('subcategoryId', e.target.value)}
            disabled={subcategories.length === 0}
          >
            <option value="">
              {!form.categoryId
                ? 'Select a category first'
                : subcategories.length === 0
                  ? 'No subcategories'
                  : 'None'}
            </option>
            {subcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Sales description"
          htmlFor="field-description"
          help="Appears on sales forms and receipts — helps you and your customers identify the product."
          className="sm:col-span-2"
        >
          <Textarea
            id="field-description"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Optional sales description"
            rows={3}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <Button asChild variant="link" size="sm">
          <Link href="/products/categories">
            <Settings2 className="mr-1 h-3.5 w-3.5" /> Manage categories
          </Link>
        </Button>
      </div>

      {/* POS-side photo — stored in S3; never sent to any external catalogue. */}
      <div className="space-y-3 rounded-2xl border border-border bg-surface p-5">
        <div>
          <h3 className="text-sm font-semibold">Product image</h3>
          <p className="text-xs text-muted-foreground">{presentation.imageHelpText}</p>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        {imageSrc ? (
          <div className="flex items-start gap-4">
            <ProductImage
              src={imageSrc}
              alt={form.name || 'Product image'}
              className="h-40 w-40 shrink-0 rounded-xl"
            />
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={imageBusy}
                leftIcon={
                  imageBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )
                }
                onClick={() => fileInput.current?.click()}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                className="text-danger"
                disabled={imageBusy}
                onClick={onRemoveImage}
                leftIcon={<Trash2 className="h-4 w-4" />}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors',
              dragOver ? 'border-brand-600 bg-brand-50' : 'border-border bg-muted/30 hover:bg-muted',
            )}
          >
            {imageBusy ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : (
              <UploadCloud className="h-8 w-8 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">Upload or drag &amp; drop an image</span>
            <span className="text-xs text-muted-foreground">
              Square image recommended · PNG, JPG or WebP · max 5 MB
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
