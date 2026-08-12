'use client';

import { Loader2, PackagePlus } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { type Session } from '@/lib/auth';
import type { BranchSummary } from '@/lib/products/branches-api';
import {
  createReceipt,
  type CreateReceiptPayload,
  type InventoryReceipt,
} from '@/lib/products/receipts-api';
import type { ProductVariant } from '@/lib/products/variants-api';
import type { ManagedProduct } from '@/lib/products-api';
import type { Supplier } from '@/lib/suppliers/types';
import { formatMoney } from '@/lib/utils';

/**
 * Receive Stock dialog (D44).
 *
 * Records a single-line goods receipt from a supplier into one branch. The
 * server owns weighted-average maintenance and history preservation — this
 * form's only job is to gather a well-shaped payload, guard against duplicate
 * posts with an idempotency key, and warn about margin-pinching cost jumps
 * BEFORE the operator saves so the surprise doesn't land in a report.
 *
 * The cost-jump warning is a soft banner, never a block: the operator is the
 * authority on what actually arrived; the UI's job is to make the effect
 * visible rather than to overrule it.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  session: Session;
  product: ManagedProduct;
  variants: ProductVariant[];
  branches: BranchSummary[];
  suppliers: Supplier[];
  defaultVariantId?: string;
  onSuccess: (receipt: InventoryReceipt) => void;
}

// Anything over a 5% jump from the current weighted-average is worth surfacing;
// smaller drift is normal supplier variance and would train the operator to
// ignore the warning. Never triggers for decreases.
const COST_WARNING_THRESHOLD = 0.05;

/** Local ISO date (YYYY-MM-DD) for today, avoiding a UTC-shift near midnight. */
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function variantDisplayLabel(v: ProductVariant): string {
  const parts = v.optionValues.map((o) => o.optionName).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : v.sku;
}

export function ReceiveStockDialog({
  open,
  onClose,
  session,
  product,
  variants,
  branches,
  suppliers,
  defaultVariantId,
  onSuccess,
}: Props) {
  const hasVariants = product.hasVariants && variants.length > 0;
  const activeVariants = React.useMemo(
    () => variants.filter((v) => v.isActive),
    [variants],
  );

  // Sensible default branch: single-branch tenants (most SMBs) never see the
  // branch select as a choice they have to think about.
  const defaultBranchId = branches[0]?.id ?? '';

  const [variantId, setVariantId] = React.useState<string>('');
  const [branchId, setBranchId] = React.useState<string>(defaultBranchId);
  const [supplierId, setSupplierId] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState<string>('');
  const [unitCost, setUnitCost] = React.useState<string>('');
  const [receivedAt, setReceivedAt] = React.useState<string>(todayISO());
  const [invoiceReference, setInvoiceReference] = React.useState<string>('');
  const [grnReference, setGrnReference] = React.useState<string>('');
  const [lotNumber, setLotNumber] = React.useState<string>('');
  const [expiryDate, setExpiryDate] = React.useState<string>('');
  const [notes, setNotes] = React.useState<string>('');
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  // A fresh idempotency key per open — resets on close so a re-opened dialog
  // is a fresh transaction, not a retry of the previous one.
  const [idempotencyKey, setIdempotencyKey] = React.useState<string>(() => cryptoRandomId());

  // Whenever the dialog is (re-)opened, reset field state to the sensible
  // defaults so leftovers from a previous receive never bleed through.
  React.useEffect(() => {
    if (!open) return;
    setVariantId(defaultVariantId ?? (hasVariants ? (activeVariants[0]?.id ?? '') : ''));
    setBranchId(defaultBranchId);
    setSupplierId('');
    setQuantity('');
    setUnitCost('');
    setReceivedAt(todayISO());
    setInvoiceReference('');
    setGrnReference('');
    setLotNumber('');
    setExpiryDate('');
    setNotes('');
    setSaveState('idle');
    setError(null);
    setIdempotencyKey(cryptoRandomId());
  }, [open, defaultVariantId, defaultBranchId, hasVariants, activeVariants]);

  const selectedVariant = hasVariants
    ? variants.find((v) => v.id === variantId) ?? null
    : null;

  // Cost-jump warning. Only meaningful when we have a baseline (`averageCost`),
  // a positive typed cost, and the increase clears the noise threshold. NEVER
  // renders for a decrease — a supplier that dropped their price is good news,
  // not a warning.
  const parsedCost = Number(unitCost);
  const showCostWarning = (() => {
    if (!Number.isFinite(parsedCost) || parsedCost <= 0) return false;
    const baseline = selectedVariant?.averageCost;
    if (baseline == null || baseline <= 0) return false;
    const ratio = parsedCost / baseline - 1;
    return ratio > COST_WARNING_THRESHOLD;
  })();
  const costWarningPercent = selectedVariant?.averageCost
    ? Math.round((parsedCost / selectedVariant.averageCost - 1) * 100)
    : 0;

  const canSubmit =
    saveState !== 'saving' &&
    branchId.trim().length > 0 &&
    Number(quantity) > 0 &&
    Number(unitCost) >= 0 &&
    unitCost.trim().length > 0 &&
    receivedAt.trim().length > 0 &&
    (!hasVariants || variantId.trim().length > 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaveState('saving');
    setError(null);

    const payload: CreateReceiptPayload = {
      branchId,
      supplierId: supplierId || undefined,
      receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
      invoiceReference: invoiceReference.trim() || undefined,
      grnReference: grnReference.trim() || undefined,
      notes: notes.trim() || undefined,
      idempotencyKey,
      lines: [
        {
          productId: product.id,
          productVariantId: hasVariants && variantId ? variantId : undefined,
          quantityReceived: Number(quantity),
          unitCost: Number(unitCost),
          lotNumber: lotNumber.trim() || undefined,
          expiryDate: expiryDate ? new Date(expiryDate).toISOString() : undefined,
        },
      ],
    };

    try {
      const receipt = await createReceipt(session, payload);
      setSaveState('saved');
      // Small delay so screen-readers announce the check-mark state before the
      // dialog vanishes; matches the wizard's save-transition pattern.
      setTimeout(() => {
        onSuccess(receipt);
        onClose();
      }, 350);
    } catch (err) {
      setSaveState('idle');
      setError(err instanceof Error ? err.message : 'Could not record receipt');
    }
  };

  const variantLabelForToast = selectedVariant ? variantDisplayLabel(selectedVariant) : null;

  return (
    <Dialog
      open={open}
      onClose={saveState === 'saving' ? () => undefined : onClose}
      title="Receive stock"
      description="Record stock delivered by a supplier into this branch. Historical purchase costs are never overwritten."
      className="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="rs-product">Product</Label>
            <p
              id="rs-product"
              className="mt-1 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-sm"
            >
              {product.name}
              {variantLabelForToast ? (
                <span className="text-muted-foreground"> — {variantLabelForToast}</span>
              ) : null}
            </p>
          </div>

          {hasVariants ? (
            <div className="sm:col-span-2">
              <Label htmlFor="rs-variant">Variant</Label>
              <Select
                id="rs-variant"
                value={variantId}
                onChange={(e) => setVariantId(e.target.value)}
                required
                className="mt-1"
              >
                <option value="">— Select variant —</option>
                {activeVariants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {variantDisplayLabel(v)}
                    {v.sku ? ` · ${v.sku}` : ''}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          <div>
            <Label htmlFor="rs-branch">Branch</Label>
            <Select
              id="rs-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              required
              className="mt-1"
            >
              <option value="">— Select branch —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="rs-supplier">Supplier</Label>
            <Select
              id="rs-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="mt-1"
            >
              <option value="">— Select supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="rs-quantity">Quantity received</Label>
            <Input
              id="rs-quantity"
              type="number"
              step="0.001"
              min="0.001"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="rs-unit-cost">Unit purchase cost</Label>
            <div className="relative mt-1">
              {/* LKR is rendered inside the input so the currency is part of the
                  field, not a separate label that could wrap away from it. */}
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                LKR
              </span>
              <Input
                id="rs-unit-cost"
                type="number"
                step="0.01"
                min="0"
                required
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="0.00"
                className="pl-12"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="rs-received-at">Received date</Label>
            <Input
              id="rs-received-at"
              type="date"
              required
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="rs-invoice">Supplier invoice</Label>
            <Input
              id="rs-invoice"
              type="text"
              value={invoiceReference}
              onChange={(e) => setInvoiceReference(e.target.value)}
              placeholder="Optional"
              className="mt-1"
              maxLength={80}
            />
          </div>

          <div>
            <Label htmlFor="rs-grn">GRN / Goods receipt number</Label>
            <Input
              id="rs-grn"
              type="text"
              value={grnReference}
              onChange={(e) => setGrnReference(e.target.value)}
              placeholder="Optional"
              className="mt-1"
              maxLength={80}
            />
          </div>

          <div>
            <Label htmlFor="rs-lot">Lot / Batch number</Label>
            <Input
              id="rs-lot"
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              placeholder="Optional"
              className="mt-1"
              maxLength={80}
            />
          </div>

          <div>
            <Label htmlFor="rs-expiry">Expiry date</Label>
            <Input
              id="rs-expiry"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="rs-notes">Notes</Label>
            <Textarea
              id="rs-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              maxLength={400}
              className="mt-1"
            />
          </div>
        </div>

        {showCostWarning && selectedVariant?.averageCost != null ? (
          <div
            role="status"
            className="rounded-2xl border border-warning-soft bg-warning-soft/40 p-4 text-warning"
          >
            <p className="text-sm">
              Purchase cost is {costWarningPercent}% higher than the current
              weighted-average of {formatMoney(selectedVariant.averageCost)}. Current margin
              will decrease. You can update the selling price on the Variants tab after saving.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
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
            disabled={!canSubmit || saveState === 'saved'}
            leftIcon={
              saveState === 'saving' ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <PackagePlus className="h-4 w-4" />
              )
            }
          >
            {saveState === 'saving'
              ? 'Receiving...'
              : saveState === 'saved'
                ? 'Stock received'
                : 'Receive Stock'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * `crypto.randomUUID()` is present in every runtime this app targets (modern
 * browsers + jsdom), but Node before 19 in a stray CI job could still be
 * without it; fall back to `Math.random` rather than throwing an idempotency
 * key that clashes on retries.
 */
function cryptoRandomId(): string {
  const g = globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
