'use client';

import { ChefHat } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type Session } from '@/lib/auth';
import { menuItems as menuItemsApi } from '@/lib/restaurant/api';
import type { MenuItemView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  sectionId: string;
  onCreated: (item: MenuItemView) => void;
  onBack: () => void;
}

/**
 * Add a **Prepared Dish** — a menu item the kitchen makes from scratch, with
 * no inventory link. Pilot Change 4 Section "Prepared Item Flow".
 *
 * Fields intentionally omitted from this form:
 *   - SKU / Barcode / Reorder point — those live on Product administration.
 *   - QuickBooks / Sync status — accounting metadata, not menu presentation.
 *
 * Restaurant selling metadata that DOES belong here (menu price, description,
 * modifier groups, station routing, availability) either lives on this form
 * or attaches to the item after save through the existing menu-item edit
 * surface. Kitchen-station routing + modifier group assignment stay as
 * follow-up steps for the pilot — same behaviour as today, no regression.
 */
export function PreparedDishDialog({ session, sectionId, onCreated, onBack }: Props) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [price, setPrice] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const priceNum = Number(price);
  const priceIsValid = price !== '' && Number.isFinite(priceNum) && priceNum >= 0;
  const canSubmit = name.trim().length > 0 && priceIsValid;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const created = await menuItemsApi.create(session, sectionId, {
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        // Deliberately no productId — a Prepared Dish never carries an
        // inventory link.
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create menu item');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onBack}
      title="New prepared dish"
      description="Modifier groups, kitchen station and channel prices can be added after saving."
      footer={
        <>
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            Back
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!canSubmit}>
            Create dish
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ChefHat className="h-4 w-4 text-primary" />
          <span>
            Prepared dishes are tracked by the menu itself, not by inventory. Recipe /
            ingredient depletion is a separate future capability.
          </span>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pd-name">
            Name
          </label>
          <Input
            id="pd-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Chicken Kottu"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pd-desc">
            Description
          </label>
          <Textarea
            id="pd-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — a short sentence for the menu card."
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pd-price">
            Menu price (LKR)
          </label>
          <Input
            id="pd-price"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="e.g. 1200"
          />
          {price !== '' && !priceIsValid ? (
            <p className="text-xs text-danger">Enter a non-negative number.</p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
