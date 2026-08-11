'use client';

import { Info, Package } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type Session } from '@/lib/auth';
import { menuItems as menuItemsApi } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { ManagedProduct } from '@/lib/products-api';
import type { MenuItemView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  sectionId: string;
  product: ManagedProduct;
  onCreated: (item: MenuItemView) => void;
  onBack: () => void;
}

/**
 * Add a menu item that surfaces an existing inventory Product. The Product
 * remains the inventory authority; the Menu Item owns customer-facing name,
 * description, and menu price.
 *
 * Pricing rule (Section "Pricing rule"): menu price may differ from the
 * Product base price. Default the menu price to the Product's base price,
 * but the operator is free to change it (e.g. Dinner menu upsell).
 *
 * The read-only Product reference card is the visual proof that the two
 * sides are separate — the operator sees exactly what stock authority they
 * are linking to, and cannot edit it from here.
 */
export function LinkedProductDialog({
  session,
  sectionId,
  product,
  onCreated,
  onBack,
}: Props) {
  const [displayName, setDisplayName] = React.useState(product.name);
  const [description, setDescription] = React.useState('');
  const [price, setPrice] = React.useState(String(product.unitPrice));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const priceNum = Number(price);
  const priceIsValid = price !== '' && Number.isFinite(priceNum) && priceNum >= 0;
  const canSubmit = displayName.trim().length > 0 && priceIsValid;
  const priceChanged = priceIsValid && priceNum !== product.unitPrice;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const created = await menuItemsApi.create(session, sectionId, {
        name: displayName.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        productId: product.id,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link product');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onBack}
      title="Link inventory product"
      description="The product stays the inventory authority. Set the customer-facing name and menu price here."
      footer={
        <>
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            Back
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!canSubmit}>
            Link to menu
          </Button>
        </>
      }
      className="max-w-lg"
    >
      <div className="space-y-4">
        {/* Read-only product reference — the "two sides are separate" proof. */}
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Product (inventory authority)
          </p>
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/12 p-2 text-primary">
              <Package className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{product.name}</p>
              <p className="text-xs text-muted-foreground">
                SKU {product.sku ?? '—'}
                {product.type === 'Inventory'
                  ? ` · Current stock ${product.quantityOnHand}`
                  : ` · ${product.type}`}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Base price {formatMoney(product.unitPrice)}
              </p>
            </div>
          </div>
        </div>

        {/* Menu presentation — the editable side. */}
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Menu presentation
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="lp-name">
            Display name
          </label>
          <Input
            id="lp-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="How the item appears on the menu"
          />
          <p className="text-xs text-muted-foreground">
            Defaults to the product name — override if you want the menu label to differ.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="lp-desc">
            Menu description
          </label>
          <Textarea
            id="lp-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — extra copy for the menu card only."
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="lp-price">
            Menu price (LKR)
          </label>
          <Input
            id="lp-price"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          {priceChanged ? (
            <p className="flex items-center gap-1 text-xs text-info">
              <Info className="h-3.5 w-3.5" />
              Menu price ({formatMoney(priceNum)}) differs from the product base price
              ({formatMoney(product.unitPrice)}) — this menu will use the menu price.
            </p>
          ) : null}
          {price !== '' && !priceIsValid ? (
            <p className="text-xs text-danger">Enter a non-negative number.</p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
