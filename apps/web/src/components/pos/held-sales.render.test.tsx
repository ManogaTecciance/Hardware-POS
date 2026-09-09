/**
 * Held baskets — the discard guard (D141).
 *
 * ## What is actually at risk here
 *
 * Discarding a held basket deletes a draft sale on the server, and nothing
 * brings it back. The only thing standing between a mis-tap and that call is
 * the confirm, and when the confirm stopped being `window.confirm` it stopped
 * being synchronous: the guard is now an `await`, and an `await` that is
 * dropped, or a promise that resolves to the wrong thing, deletes the basket
 * with no question asked and looks exactly like working code.
 *
 * So both halves are asserted, always as a pair:
 *
 *   * confirming DOES call `discardHeldSale` (and reloads the list), and
 *   * dismissing does NOT call it, with the question itself asserted first so
 *     the negative cannot pass because the Discard button never rendered.
 *
 * The `window.confirm` spy is the third leg: the native dialog is a no-op in
 * jsdom that returns `undefined`, so a reverted call site would fall through
 * to `return` and the "confirming discards" test would fail — but the spy says
 * *why*, and it fails even if some future jsdom starts answering `true`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { HeldSale } from '@/lib/held-sales';
import { PosCartProvider } from '@/lib/pos-cart';

const listHeldSales = vi.fn<(...args: unknown[]) => Promise<HeldSale[]>>();
const discardHeldSale = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('@/lib/held-sales', () => ({
  listHeldSales: (...args: unknown[]) => listHeldSales(...args),
  discardHeldSale: (...args: unknown[]) => discardHeldSale(...args),
  createDraftSale: vi.fn(),
  toDraftLinePayload: (item: unknown) => item,
}));

const { HeldSalesButton } = await import('./held-sales');

function heldSale(overrides: Partial<HeldSale> = {}): HeldSale {
  return {
    id: 'sale_held_1',
    saleNumber: 'S-1042',
    createdAt: '2026-09-01T10:00:00.000Z',
    branchId: 'br_1',
    customerId: null,
    customerName: 'Nadeesha',
    cashierName: 'Ravi',
    subtotal: 4500,
    items: [
      {
        productId: 'prod_cement',
        productVariantId: null,
        productName: 'Cement 50kg',
        variantNameSnapshot: null,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

const session = { token: 't', user: { id: 'u1', tenantId: 'tnt' } } as never;

/** Renders the button and opens the "Held baskets" dialog. */
async function openHeldDialog(sales: HeldSale[]) {
  listHeldSales.mockResolvedValue(sales);
  render(
    <ConfirmProvider>
      <PosCartProvider>
        <HeldSalesButton session={session} branchId="br_1" products={[]} items={[]} customerId="" />
      </PosCartProvider>
    </ConfirmProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Held/ }));
  // The list is what the Discard buttons hang off, so wait for it rather than
  // for the dialog frame.
  await screen.findByText(/S-1042/);
}

// Answering `true` on purpose: if the call site ever went back to the native
// dialog, the destructive path would be WIDE OPEN and the dismissal test below
// would fail loudly instead of accidentally passing on jsdom's `undefined`.
const spyOnNativeConfirm = () => vi.spyOn(window, 'confirm').mockReturnValue(true);

let nativeConfirm: ReturnType<typeof spyOnNativeConfirm>;

beforeEach(() => {
  nativeConfirm = spyOnNativeConfirm();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('HeldSalesButton — discarding a held basket', () => {
  it('asks first, and discards only after the destructive action is confirmed', async () => {
    await openHeldDialog([heldSale()]);
    listHeldSales.mockResolvedValue([]); // the reload that follows the delete

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    // The question names THIS basket and keeps the warning the native string
    // carried; "Discard held basket?" alone would not say which one is going.
    await screen.findByRole('heading', { name: 'Discard held basket S-1042?' });
    expect(document.body.textContent).toContain('This cannot be undone.');
    // Nothing has been deleted yet — the guard is holding the call back.
    expect(discardHeldSale).not.toHaveBeenCalled();

    // A verb, not "OK": the button says what pressing it destroys.
    fireEvent.click(screen.getByRole('button', { name: 'Discard basket' }));

    await waitFor(() => expect(discardHeldSale).toHaveBeenCalledTimes(1));
    expect(discardHeldSale).toHaveBeenCalledWith(session, 'sale_held_1');
    // …and the list is reloaded, so the discarded basket leaves the screen.
    await waitFor(() => expect(screen.queryByText(/S-1042/)).toBeNull());
    expect(screen.getByText(/Nothing is on hold/)).toBeDefined();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('does NOT discard when the question is dismissed, and leaves the basket held', async () => {
    await openHeldDialog([heldSale()]);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // Positive control: the question really was asked, so the negative below
    // cannot pass because the Discard button was missing or inert.
    await screen.findByRole('heading', { name: 'Discard held basket S-1042?' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /Discard held basket/ })).toBeNull(),
    );
    expect(discardHeldSale).not.toHaveBeenCalled();
    // The basket is still on hold and still listed.
    expect(screen.getByText(/S-1042/)).toBeDefined();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('names the basket whose Discard was pressed, not the first in the list', async () => {
    await openHeldDialog([heldSale(), heldSale({ id: 'sale_held_2', saleNumber: 'S-1043' })]);

    const discardButtons = screen.getAllByRole('button', { name: 'Discard' });
    expect(discardButtons).toHaveLength(2);
    fireEvent.click(discardButtons[1]!);

    await screen.findByRole('heading', { name: 'Discard held basket S-1043?' });
    expect(screen.queryByRole('heading', { name: 'Discard held basket S-1042?' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard basket' }));
    await waitFor(() => expect(discardHeldSale).toHaveBeenCalledWith(session, 'sale_held_2'));
  });
});
