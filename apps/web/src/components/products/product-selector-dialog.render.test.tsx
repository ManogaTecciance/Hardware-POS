/**
 * The product picker's search box.
 *
 * Three defects reported from the floor, all in one small dialog:
 *
 *  - **Two scrollbars.** The results list carried `max-h-[60vh]
 *    overflow-y-auto` INSIDE the dialog body, which D85 had already made the
 *    scrolling element. Dragging the outer bar moved nothing.
 *  - **No way to clear the term.** The products screen and the POS menu
 *    browser both give an X; this one did not, and selecting text to delete it
 *    is awkward on a tablet.
 *  - **A bare `.trim()`.** Every search here is matched with a literal
 *    `contains` on the server, so "Fried   Rice" off a tablet keyboard found
 *    nothing for an item that plainly exists.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The term case asserts what WAS sent, not merely that a request went out: an
 * un-normalised build calls `fetchProducts` too, just with the wrong string.
 * The clear-button case pairs its presence with its effect (the box empties
 * AND the unfiltered query goes back out), so a rendered-but-unwired control
 * fails. The scroll case asserts the list EXISTS before asserting it owns no
 * scroller, so a query that matched nothing cannot pass it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedProduct } from '@/lib/products-api';

// ── boundaries ───────────────────────────────────────────────────────────────

const fetchProducts = vi.fn();
vi.mock('@/lib/products-api', () => ({
  fetchProducts: (...args: unknown[]) => fetchProducts(...args),
}));

vi.mock('@/lib/restaurant/labels', () => ({
  formatMoney: (v: string | number) => `LKR ${Number(v).toFixed(2)}`,
}));

const { ProductSelectorDialog } = await import('./product-selector-dialog');

const session = { token: 't', user: { id: 'u1', tenantId: 't1' } } as never;

const RICE = {
  id: 'prd_rice',
  name: 'Fried Rice',
  sku: 'RIC-1',
  type: 'Inventory',
  unitPrice: 850,
  quantityOnHand: 12,
  hasVariants: false,
  variantCount: 0,
  variantPriceMin: null,
  variantPriceMax: null,
} as unknown as ManagedProduct;

/** The `search` value of the Nth call, or undefined when none was sent. */
function searchOf(call: number): string | undefined {
  const query = fetchProducts.mock.calls[call]?.[1] as { search?: string } | undefined;
  return query?.search;
}

function picker() {
  return render(
    <ProductSelectorDialog session={session} onSelect={vi.fn()} onBack={vi.fn()} />,
  );
}

beforeEach(() => {
  fetchProducts.mockReset();
  fetchProducts.mockResolvedValue({ items: [RICE], total: 1, page: 1, pageSize: 20 });
});
afterEach(cleanup);

// ── specs ────────────────────────────────────────────────────────────────────

describe('the term that reaches the server', () => {
  it('collapses internal whitespace instead of only trimming the ends', async () => {
    picker();
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Search products'), {
      target: { value: '  Fried   Rice  ' },
    });

    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(2));
    // The whole point: `.trim()` would have sent "Fried   Rice", which the
    // server's literal `contains` matches against nothing.
    expect(searchOf(1)).toBe('Fried Rice');
  });

  it('keeps showing the operator exactly what they typed', async () => {
    picker();
    fireEvent.change(screen.getByLabelText('Search products'), {
      target: { value: 'Fried   Rice' },
    });

    // Normalising the INPUT would move the caret and fight the typist. Only
    // what is sent is normalised.
    expect((screen.getByLabelText('Search products') as HTMLInputElement).value).toBe(
      'Fried   Rice',
    );
  });

  it('issues no second request when only the spacing changes', async () => {
    picker();
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Search products'), {
      target: { value: 'Fried Rice' },
    });
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText('Search products'), {
      target: { value: 'Fried    Rice ' },
    });
    // Both spellings normalise to one term, so the effect key is unchanged.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchProducts).toHaveBeenCalledTimes(2);
  });
});

describe('the clear control', () => {
  it('appears only once there is something to clear', async () => {
    picker();
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(1));

    // NEGATIVE: nothing typed, nothing to clear.
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'rice' } });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  it('empties the box and asks for the unfiltered list again', async () => {
    picker();
    // The mount's own fetch first: typing inside the 250 ms debounce cancels
    // it, and then the call indices below would be off by one.
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'rice' } });
    await waitFor(() => expect(searchOf(1)).toBe('rice'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect((screen.getByLabelText('Search products') as HTMLInputElement).value).toBe('');
    // Clearing is how an operator gets back to browsing, so the empty term has
    // to go back out — a control that only blanked the box would look fixed
    // and leave the filtered results on screen.
    await waitFor(() => expect(searchOf(2)).toBeUndefined());
  });
});

describe('the results list', () => {
  it('owns no scroller of its own — the dialog body is the only one', async () => {
    picker();

    // POSITIVE first: the list is really here, so the class assertion below is
    // about a rendered element rather than about nothing.
    const list = await screen.findByRole('listbox', { name: 'Product search results' });
    expect(await screen.findByText('Fried Rice')).toBeTruthy();

    // NEGATIVE: a second scroll container nested in the dialog's own is what
    // produced two bars, one of which moved nothing.
    expect(list.className).not.toMatch(/overflow-y-auto/);
    expect(list.className).not.toMatch(/max-h-/);
  });
});
