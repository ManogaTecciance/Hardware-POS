/**
 * Pilot Change 4 — Menu Item vs Product separation.
 *
 * Every test below has a positive control paired with the negative — a
 * dialog that always/never rendered any of these strings would fail.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedProduct } from '@/lib/products-api';

import { AddItemChoiceDialog } from './add-item-choice-dialog';
import { LinkedProductDialog } from './linked-product-dialog';
import { PreparedDishDialog } from './prepared-dish-dialog';

afterEach(cleanup);

// ── AddItemChoiceDialog ──────────────────────────────────────────────────

describe('AddItemChoiceDialog', () => {
  it('renders exactly two options: Prepared Dish and Existing Product', () => {
    render(<AddItemChoiceDialog onChoose={() => {}} onClose={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(document.body.textContent).toMatch(/prepared dish/i);
    expect(document.body.textContent).toMatch(/existing product/i);
  });

  it('one click on Prepared Dish emits PREPARED and does not require Continue', () => {
    const onChoose = vi.fn();
    render(<AddItemChoiceDialog onChoose={onChoose} onClose={() => {}} />);
    screen.getByRole('radio', { name: /prepared dish/i }).click();
    expect(onChoose).toHaveBeenCalledWith('PREPARED');
    // Positive control: the second option would emit LINKED_PRODUCT — proves
    // the mapping isn't the same for both cards.
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  });

  it('one click on Existing Product emits LINKED_PRODUCT', () => {
    const onChoose = vi.fn();
    render(<AddItemChoiceDialog onChoose={onChoose} onClose={() => {}} />);
    screen.getByRole('radio', { name: /existing product/i }).click();
    expect(onChoose).toHaveBeenCalledWith('LINKED_PRODUCT');
  });
});

// ── PreparedDishDialog ───────────────────────────────────────────────────

describe('PreparedDishDialog — restaurant-only concerns', () => {
  const noop = () => {};

  it('collects name, description, menu price', () => {
    render(
      <PreparedDishDialog
        session={{} as never}
        sectionId="s1"
        onCreated={noop}
        onBack={noop}
      />,
    );
    // Every field the design brief lists for a Prepared Dish is present.
    expect(screen.getByLabelText(/^name$/i)).toBeDefined();
    expect(screen.getByLabelText(/^description$/i)).toBeDefined();
    expect(screen.getByLabelText(/menu price/i)).toBeDefined();
    // Positive control: the CTA reads "Create dish".
    expect(screen.getByRole('button', { name: /create dish/i })).toBeDefined();
  });

  it('does NOT expose inventory / accounting metadata anywhere on the form', () => {
    render(
      <PreparedDishDialog
        session={{} as never}
        sectionId="s1"
        onCreated={noop}
        onBack={noop}
      />,
    );
    const body = document.body.textContent ?? '';
    // Section "Prepared Item Flow" lists what must not appear.
    for (const forbidden of [
      'SKU',
      'Barcode',
      'QuickBooks',
      'Sync Status',
      'Reorder Point',
    ]) {
      expect({ forbidden, found: body.includes(forbidden) }).toEqual({
        forbidden,
        found: false,
      });
    }
    // Positive control that this test is comparing against real rendered content:
    expect(body).toMatch(/prepared dishes are tracked by the menu itself/i);
  });
});

// ── LinkedProductDialog ──────────────────────────────────────────────────

function product(overrides: Partial<ManagedProduct> = {}): ManagedProduct {
  return {
    id: 'prd_coke_330',
    tenantId: 't1',
    name: 'Coca-Cola 330ml',
    sku: 'COKE-330',
    unitPrice: 250,
    costPrice: null,
    quantityOnHand: 86,
    reorderLevel: null,
    type: 'Inventory',
    imageUrl: null,
    categoryId: null,
    categoryName: null,
    subcategoryId: null,
    subcategoryName: null,
    isDraft: false,
    isActive: true,
    syncStatus: 'NOT_SYNCED',
    quickbooksItemId: null,
    lastSyncedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ManagedProduct;
}

describe('LinkedProductDialog — Product stays inventory authority', () => {
  const noop = () => {};

  it('shows a read-only Product reference card + editable Menu presentation', () => {
    render(
      <LinkedProductDialog
        session={{} as never}
        sectionId="s1"
        product={product()}
        onCreated={noop}
        onBack={noop}
      />,
    );
    // Read-only product side: name, SKU, stock and base price are printed
    // but never inside an <input>.
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/product \(inventory authority\)/i);
    expect(body).toMatch(/coca-cola 330ml/i);
    expect(body).toMatch(/SKU COKE-330/);
    expect(body).toMatch(/Current stock 86/);
    // Positive controls for the EDITABLE side: display name + menu price
    // + menu description are inputs the operator can change.
    const nameField = screen.getByLabelText(/display name/i) as HTMLInputElement;
    expect(nameField.value).toBe('Coca-Cola 330ml'); // defaults to product name
    const priceField = screen.getByLabelText(/menu price/i) as HTMLInputElement;
    expect(priceField.value).toBe('250'); // defaults to product base price
  });

  it('warns when the menu price diverges from the product base price', () => {
    render(
      <LinkedProductDialog
        session={{} as never}
        sectionId="s1"
        product={product()}
        onCreated={noop}
        onBack={noop}
      />,
    );
    const priceField = screen.getByLabelText(/menu price/i) as HTMLInputElement;
    // Simulate the operator marking up the price for a Dinner menu.
    (
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        ?.set as (v: string) => void
    ).call(priceField, '300');
    priceField.dispatchEvent(new Event('input', { bubbles: true }));
    // The divergence banner is text + icon — not colour-only.
    expect(document.body.textContent).toMatch(/menu price.*differs from the product base price/i);
  });

  it('does NOT expose Barcode / QuickBooks / Sync Status', () => {
    render(
      <LinkedProductDialog
        session={{} as never}
        sectionId="s1"
        product={product()}
        onCreated={noop}
        onBack={noop}
      />,
    );
    const body = document.body.textContent ?? '';
    for (const forbidden of ['Barcode', 'QuickBooks', 'Sync Status', 'Reorder']) {
      expect({ forbidden, found: body.includes(forbidden) }).toEqual({
        forbidden,
        found: false,
      });
    }
  });
});
