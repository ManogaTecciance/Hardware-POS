/**
 * The order drawer — what the full record adds, and what the row still
 * carries when there is no full record.
 *
 * The drawer renders the queue row instantly and upgrades in place when the
 * detail endpoint answers. Both halves are pinned: the upgraded sections
 * (line prices, money breakdown, destination, timeline) AND the degraded
 * ones (a failed fetch must fall back to the row, never to an error). The
 * "Context" row is asserted in both directions — absent on takeaway where it
 * duplicated the customer's name, present as "Table" on dine-in where it is
 * real information — because a fix that simply deleted the row would pass
 * the takeaway case alone.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';
import type { UnifiedOrderDetail, UnifiedOrderView } from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const SESSION = {
  token: 'tok',
  user: {
    id: 'usr_1',
    name: 'Cashier',
    email: 'cashier@example.test',
    role: 'CASHIER',
    tenantId: 'tnt_1',
    permissions: [],
  },
  branchId: 'brn_1',
  registerId: null,
  branchName: 'Main',
  registerName: 'R1',
} as unknown as Session;

let canTakeaway = true;
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: SESSION, hasPermission: () => canTakeaway }),
}));
vi.mock('@/lib/use-viewport', () => ({ useOrientation: () => 'landscape' }));
vi.mock('@/components/restaurant/billing/bill-dialog', () => ({ BillDialog: () => null }));

const detailFn = vi.fn();
const updateStatusFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  restaurantOrders: { detail: (...args: unknown[]) => detailFn(...args) },
  takeaway: { updateStatus: (...args: unknown[]) => updateStatusFn(...args) },
}));

const { OrderDetailDrawer } = await import('./order-detail-drawer');

// ── fixtures ─────────────────────────────────────────────────────────────────

/** The row the user's screenshot showed: takeaway, taken over the phone. */
const ROW: UnifiedOrderView = {
  // D157 — the counter user who keyed it. Not this spec's subject, but the row
  // shape carries it now and a fixture missing it would not be a real row.
  staffUserId: 'usr_till',
  staffName: 'Restaurant Cashier',
  id: 'ord_1',
  channel: 'TAKEAWAY',
  source: 'PHONE_ORDER',
  orderNumber: 'RO-000028',
  unifiedStatus: 'HANDED_OVER',
  paymentStatus: 'PAID',
  customerName: 'lahiru',
  customerPhone: '0766727512',
  contextLabel: 'lahiru',
  pickupAt: null,
  createdAt: '2026-09-03T10:50:00.000Z',
  total: '715.00',
  saleId: 'sal_1',
  itemCount: 1,
  itemPreview: [{ name: 'Garden Salad', qty: 1 }],
};

const DETAIL: UnifiedOrderDetail = {
  ...ROW,
  deliveryAddress: '12 Galle Rd, Colombo',
  notes: null,
  items: [
    {
      name: 'Garden Salad',
      variantName: null,
      quantity: '1',
      unitPrice: '650.00',
      modifierTotal: '65.00',
      lineTotal: '715.00',
      specialInstructions: null,
      modifiers: [{ optionName: 'Extra dressing', groupName: 'Add-ons', priceDelta: '65.00' }],
    },
  ],
  financials: {
    subtotal: '715.00',
    totalDiscount: '0.00',
    serviceChargeAmount: '0.00',
    packagingCharge: '0.00',
    taxAmount: '0.00',
    total: '715.00',
    paidAmount: '715.00',
    balanceAmount: '0.00',
  },
  payments: [
    { method: 'CASH', amount: '715.00', reference: null, at: '2026-09-03T10:57:00.000Z' },
  ],
  timeline: [
    { at: '2026-09-03T10:51:00.000Z', status: 'PENDING' },
    { at: '2026-09-03T10:56:00.000Z', status: 'HANDED_OVER' },
  ],
  takeawayProfileId: 'tap_1',
};

beforeEach(() => {
  canTakeaway = true;
  detailFn.mockReset();
  updateStatusFn.mockReset();
  detailFn.mockResolvedValue(DETAIL);
  updateStatusFn.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the upgraded sections', () => {
  it('prices the lines and breaks the money down once the detail lands', async () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText('Subtotal')).toBeTruthy());
    // The line carries its own money and its modifier by name — the two
    // things the preview could not show.
    expect(screen.getByText('Extra dressing')).toBeTruthy();
    expect(screen.getByText('Paid · Cash')).toBeTruthy();
    // Line total + subtotal + total + payment all read 715.00.
    expect(screen.getAllByText(/715\.00/).length).toBeGreaterThanOrEqual(3);
    // Zero rows stay out: a breakdown of six zeros buries the total.
    expect(screen.queryByText('Service charge')).toBeNull();
    expect(screen.queryByText('Balance due')).toBeNull();
  });

  it('shows the delivery destination the notes workaround was hiding', async () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText('12 Galle Rd, Colombo')).toBeTruthy());
    expect(screen.getByText('Deliver to')).toBeTruthy();
  });

  it('renders the timeline under a leading Created row', async () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    expect(screen.getByText('Created')).toBeTruthy();
    // 'Pending' appears only via the timeline for this order — its live badge
    // reads 'Handed over' — so this pins the transitions, not the badge.
    await waitFor(() => expect(screen.getByText('Pending')).toBeTruthy());
  });
});

describe('the Customer section', () => {
  it('drops the Context row on takeaway, where it duplicated the name', async () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    expect(screen.queryByText('Context')).toBeNull();
    // The name still renders once, in its own row.
    expect(screen.getByText('lahiru')).toBeTruthy();
  });

  it('keeps the label on dine-in, where it is the table', async () => {
    detailFn.mockResolvedValue(null);
    const dineIn: UnifiedOrderView = {
      ...ROW,
      id: 'ord_2',
      channel: 'DINE_IN',
      source: 'POS',
      customerName: null,
      customerPhone: null,
      contextLabel: 'Table 4',
    };
    render(<OrderDetailDrawer order={dineIn} branchId="brn_1" onClose={() => undefined} />);

    expect(screen.getByText('Table')).toBeTruthy();
    expect(screen.getByText('Table 4')).toBeTruthy();
  });
});

describe('the source chip', () => {
  it('is gone on first-party orders, where it repeated the channel badge', () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    expect(screen.queryByText('via Phone')).toBeNull();
  });

  it('still names the partner on third-party orders', () => {
    // The half that proves the chip was scoped, not deleted: on 3rd-party
    // rows it is the only thing saying which platform the order came from.
    detailFn.mockResolvedValue(null);
    const thirdParty: UnifiedOrderView = {
      ...ROW,
      id: 'ext_1',
      channel: 'THIRD_PARTY',
      source: 'UBER_EATS',
      customerName: null,
      customerPhone: null,
      contextLabel: 'UE-9911',
      paymentStatus: null,
      saleId: null,
      itemCount: 0,
      itemPreview: [],
    };
    render(<OrderDetailDrawer order={thirdParty} branchId="brn_1" onClose={() => undefined} />);

    expect(screen.getByText('via Uber Eats')).toBeTruthy();
  });

  it('says "Not tracked" for a payment state that is not ours — the same badge as the row (D137)', () => {
    detailFn.mockResolvedValue(null);
    render(
      <OrderDetailDrawer
        order={{
          ...ROW,
          id: 'ext_2',
          channel: 'THIRD_PARTY',
          source: 'UBER_EATS',
          paymentStatus: null,
          saleId: null,
        }}
        branchId="brn_1"
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Not tracked')).toBeTruthy();
    // NEGATIVE — the bare dash the drawer used to print, and the badge a live
    // unbilled order would get; neither belongs to money that is not ours.
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByText('Unpaid')).toBeNull();
  });

  it('NEGATIVE control — a live row with a status shows that status, not "Not tracked"', () => {
    detailFn.mockResolvedValue(null);
    render(
      <OrderDetailDrawer
        order={{ ...ROW, paymentStatus: 'UNPAID' }}
        branchId="brn_1"
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Unpaid')).toBeTruthy();
    expect(screen.queryByText('Not tracked')).toBeNull();
  });
});

describe('degradation', () => {
  it('falls back to the row when the detail fetch fails', async () => {
    detailFn.mockRejectedValue(new Error('offline'));
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);

    await waitFor(() => expect(detailFn).toHaveBeenCalled());
    // The preview list and the row's summary still render; the upgraded
    // sections simply never appear — no error state over data we have.
    expect(screen.getByText('1× Garden Salad')).toBeTruthy();
    expect(screen.queryByText('Subtotal')).toBeNull();
  });
});

/*
 * D116 — Cancel order lives on the queue, not the kitchen. Eligibility is
 * pinned from both sides (a live takeaway offers it; a handed-over one, a
 * dine-in row, and an unpermitted viewer do not), and the confirm flow is
 * asserted to the API call it makes — the status machine the takeaway
 * workspace already uses, addressed by the detail's profile id.
 */
describe('Cancel order (D116)', () => {
  const liveTakeaway: UnifiedOrderView = { ...ROW, unifiedStatus: 'PENDING' };

  it('offers Cancel on a live takeaway once the detail brings the profile id', async () => {
    render(<OrderDetailDrawer order={liveTakeaway} branchId="brn_1" onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /cancel order/i })).toBeTruthy(),
    );
  });

  it('offers no Cancel on a handed-over takeaway, a dine-in row, or without the permission', async () => {
    const { unmount: u1 } = render(
      <OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />,
    );
    await waitFor(() => expect(detailFn).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
    u1();

    const dineIn: UnifiedOrderView = {
      ...liveTakeaway,
      channel: 'DINE_IN',
      contextLabel: 'T2 · Main',
    };
    const { unmount: u2 } = render(
      <OrderDetailDrawer order={dineIn} branchId="brn_1" onClose={() => undefined} />,
    );
    await waitFor(() => expect(detailFn).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
    u2();

    canTakeaway = false;
    render(<OrderDetailDrawer order={liveTakeaway} branchId="brn_1" onClose={() => undefined} />);
    await waitFor(() => expect(detailFn).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
  });

  it('confirming drives the takeaway status machine and refreshes the queue', async () => {
    const onClose = vi.fn();
    const onMutated = vi.fn();
    render(
      <OrderDetailDrawer
        order={liveTakeaway}
        branchId="brn_1"
        onClose={onClose}
        onMutated={onMutated}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /cancel order/i }));
    // The confirm dialog names the order and offers a way out.
    expect(screen.getByText(/Cancel RO-000028\?/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep order/i })).toBeTruthy();

    fireEvent.click(
      screen
        .getAllByRole('button', { name: /cancel order/i })
        .at(-1) as HTMLElement,
    );

    await waitFor(() =>
      expect(updateStatusFn).toHaveBeenCalledWith(SESSION, 'tap_1', { status: 'CANCELLED' }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the order when the operator backs out', async () => {
    render(<OrderDetailDrawer order={liveTakeaway} branchId="brn_1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /cancel order/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep order/i }));

    expect(updateStatusFn).not.toHaveBeenCalled();
  });
});

/*
 * D117 — handover is a button now that payment stopped implying it. Same
 * eligibility as Cancel (both halves inherited and re-pinned here), and the
 * tap is asserted to the exact status call — HANDED_OVER, nothing else —
 * with the queue refreshed and the drawer closed after.
 */
describe('Mark handed over (D117)', () => {
  const liveTakeaway: UnifiedOrderView = { ...ROW, unifiedStatus: 'READY' };

  it('hands a live takeaway over in one tap and refreshes the queue', async () => {
    const onClose = vi.fn();
    const onMutated = vi.fn();
    render(
      <OrderDetailDrawer
        order={liveTakeaway}
        branchId="brn_1"
        onClose={onClose}
        onMutated={onMutated}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /mark handed over/i }));

    await waitFor(() =>
      expect(updateStatusFn).toHaveBeenCalledWith(SESSION, 'tap_1', { status: 'HANDED_OVER' }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no handover on a row that already crossed the counter', async () => {
    render(<OrderDetailDrawer order={ROW} branchId="brn_1" onClose={() => undefined} />);
    await waitFor(() => expect(detailFn).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /mark handed over/i })).toBeNull();
  });

  it('offers no handover BEFORE the kitchen says ready (PO: only after Ready)', async () => {
    for (const unifiedStatus of ['PENDING', 'IN_PROGRESS'] as const) {
      const { unmount } = render(
        <OrderDetailDrawer
          order={{ ...ROW, unifiedStatus }}
          branchId="brn_1"
          onClose={() => undefined}
        />,
      );
      // Cancel still offered on the same row — the positive control proving
      // the actions area rendered and only handover is withheld.
      await screen.findByRole('button', { name: /cancel order/i });
      expect(screen.queryByRole('button', { name: /mark handed over/i })).toBeNull();
      unmount();
    }
  });
});
