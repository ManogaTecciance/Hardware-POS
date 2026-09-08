/**
 * D71 — the waiter's bill sheet.
 *
 * ## The claim that matters
 *
 * A split is TWO server calls that cannot be made atomic from the client:
 * close the session (which raises the Sale) and then split that Sale. The
 * dangerous failure is the second one — the table is already closed, and a
 * naive `try { close(); split() } catch { showError() }` would report
 * failure for an operation that half-succeeded, leaving the waiter to press
 * it again against a session that no longer exists.
 *
 * So the middle test asserts the half-failure explicitly: closed, reported
 * as closed, with a message naming what the cashier has to finish. It is
 * paired with the happy path, because a component that always reported
 * "closed with a warning" would satisfy the failure case alone.
 *
 * Totals are asserted to come from the SERVER's preview rather than from
 * re-adding the lines: 3 × 1000 is 3000, but the total shown is 3300 with
 * service charge, and only the server knows that.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionBillPreview } from '@/lib/restaurant/types';

const billPreview = vi.fn<() => Promise<SessionBillPreview>>();
const closeSession = vi.fn();
const splitByItems = vi.fn();

vi.mock('@/lib/restaurant/api', () => ({
  tableSessions: {
    billPreview: () => billPreview(),
    close: (...args: unknown[]) => closeSession(...args),
  },
  billing: { splitByItems: (...args: unknown[]) => splitByItems(...args) },
}));

vi.mock('@/lib/restaurant/labels', () => ({
  formatMoney: (v: string | number) => `LKR ${Number(v).toFixed(2)}`,
}));

const { TableBillSheet } = await import('./table-bill-sheet');

const PREVIEW: SessionBillPreview = {
  sessionId: 'ts_1',
  items: [
    {
      orderItemId: 'oi_1',
      name: 'Beef Steak',
      variantName: 'Medium',
      unitPrice: '1000.00',
      quantity: '2.000',
      lineTotal: '2000.00',
      roundNumber: 1,
      specialInstructions: 'no onions',
    },
    {
      orderItemId: 'oi_2',
      name: 'Garlic Bread',
      variantName: null,
      unitPrice: '1000.00',
      quantity: '1.000',
      lineTotal: '1000.00',
      roundNumber: 2,
      specialInstructions: null,
    },
  ],
  subtotal: '3000.00',
  serviceChargeAmount: '300.00',
  packagingCharge: '0.00',
  taxAmount: '0.00',
  total: '3300.00',
};

const session = { token: 't', user: { id: 'u1', tenantId: 'tnt' } } as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sheet = (
  props: Omit<Partial<React.ComponentProps<typeof TableBillSheet>>, 'onClosed'> = {},
) => {
  const onClosed = vi.fn();
  render(
    <TableBillSheet
      session={session}
      sessionId="ts_1"
      tableLabel="T7"
      hasUnsentDraft={false}
      canSplit
      onClose={vi.fn()}
      {...props}
      onClosed={onClosed}
    />,
  );
  return onClosed;
};

describe('reviewing the bill', () => {
  it('shows every round, and the SERVER’s totals rather than a re-add', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    sheet();

    expect(await screen.findByText(/Beef Steak/)).toBeTruthy();
    expect(screen.getByText('Round 1')).toBeTruthy();
    // Previous rounds are the point: a waiter answering "what have we had"
    // must see round 2 as well as round 1.
    expect(screen.getByText('Round 2')).toBeTruthy();
    expect(screen.getByText(/Garlic Bread/)).toBeTruthy();
    // Variant, because it is what the guest is being charged for.
    expect(screen.getByText('Medium')).toBeTruthy();
    // D72 — and the note, on the line the guest will point at.
    expect(screen.getByText('no onions')).toBeTruthy();

    // The lines add to 3000; the bill is 3300. Only the server knows about
    // the service charge, so this asserts the number came from it.
    expect(screen.getByText('LKR 3300.00')).toBeTruthy();
    expect(screen.getByText('LKR 300.00')).toBeTruthy();
  });

  it('hides the split action from a role that cannot split', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    sheet({ canSplit: false });

    await screen.findByText(/Beef Steak/);
    expect(screen.queryByRole('button', { name: /Split between guests/ })).toBeNull();
    /*
     * POSITIVE CONTROL — closing is still offered, so the absence above is
     * about the permission and not about a footer that failed to render.
     * Matched on the full action name: the Sheet's own dismiss control is
     * also called "Close", and a loose regex would pass on that instead.
     */
    expect(screen.getByRole('button', { name: /Close .* one bill/ })).toBeTruthy();
  });
});

describe('closing', () => {
  it('closes into one bill', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    closeSession.mockResolvedValue({ saleId: 'sale_1' });
    const onClosed = sheet();

    fireEvent.click(await screen.findByRole('button', { name: /Close .* one bill/ }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(onClosed).toHaveBeenCalledWith({ saleId: 'sale_1', splitCount: 0 });
    expect(splitByItems).not.toHaveBeenCalled();
  });

  it('closes THEN splits, and passes the new sale to the split', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    closeSession.mockResolvedValue({ saleId: 'sale_1' });
    splitByItems.mockResolvedValue({});
    const onClosed = sheet();

    fireEvent.click(await screen.findByRole('button', { name: /Split between guests/ }));
    // Assign everything to the first guest — the assigner refuses to submit
    // while any unit is unassigned.
    fireEvent.click(await screen.findByRole('button', { name: /Assign rest to/ }));
    fireEvent.click(screen.getByRole('button', { name: /Close and create/ }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledTimes(1);
    // The split targets the sale the close just produced — not the session.
    expect(splitByItems.mock.calls[0]![1]).toBe('sale_1');
    expect(onClosed).toHaveBeenCalledWith({ saleId: 'sale_1', splitCount: 1 });
  });

  it('reports the table CLOSED when the split fails afterwards', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    closeSession.mockResolvedValue({ saleId: 'sale_1' });
    splitByItems.mockRejectedValue(new Error('shares do not add up'));
    const onClosed = sheet();

    fireEvent.click(await screen.findByRole('button', { name: /Split between guests/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Assign rest to/ }));
    fireEvent.click(screen.getByRole('button', { name: /Close and create/ }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    const result = onClosed.mock.calls[0]![0] as {
      saleId: string;
      splitCount: number;
      warning?: string;
    };
    // The bill EXISTS — reporting a plain failure here would invite the
    // waiter to close a session that is already gone.
    expect(result.saleId).toBe('sale_1');
    expect(result.splitCount).toBe(0);
    // …and the message says who finishes the job.
    expect(result.warning).toMatch(/closed/i);
    expect(result.warning).toMatch(/cashier/i);
    expect(result.warning).toContain('shares do not add up');
  });

  it('does not close when the split cannot even be started', async () => {
    billPreview.mockResolvedValue(PREVIEW);
    const onClosed = sheet();

    fireEvent.click(await screen.findByRole('button', { name: /Split between guests/ }));
    // Nothing assigned yet: the primary action is disabled, so no close can
    // have been attempted. This is the ordering guarantee in the other
    // direction — the session is never closed "just in case".
    expect(
      screen.getByRole('button', { name: /Close and create/ }).hasAttribute('disabled'),
    ).toBe(true);
    expect(closeSession).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });
});
