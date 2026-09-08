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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: SESSION }) }));
vi.mock('@/lib/use-viewport', () => ({ useOrientation: () => 'landscape' }));
vi.mock('@/components/restaurant/billing/bill-dialog', () => ({ BillDialog: () => null }));

const detailFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  restaurantOrders: { detail: (...args: unknown[]) => detailFn(...args) },
}));

const { OrderDetailDrawer } = await import('./order-detail-drawer');

// ── fixtures ─────────────────────────────────────────────────────────────────

/** The row the user's screenshot showed: takeaway, taken over the phone. */
const ROW: UnifiedOrderView = {
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
};

beforeEach(() => {
  detailFn.mockReset();
  detailFn.mockResolvedValue(DETAIL);
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
