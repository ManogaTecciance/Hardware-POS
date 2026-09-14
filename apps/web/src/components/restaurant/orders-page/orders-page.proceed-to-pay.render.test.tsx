/**
 * D178 — "Proceed to pay" on the queue, and the till's half beside it.
 *
 * Three things the SCREEN owns, each paired per D30 because every failure
 * looks like the other half working:
 *
 *   - which rows carry which verb: a dine-in READY row offers Proceed to pay
 *     to a role holding TABLE_CLOSE (positive) and the SAME row offers it to
 *     nobody else, while a takeaway READY row and a dine-in PENDING row offer
 *     it to no one (negative) — a component that put the button on every card
 *     would pass only the first;
 *   - the card is still a card: the order number opens the drawer, and the
 *     footer button does NOT (the stretched-overlay regression — the card used
 *     to be one <button>, and a nested button was invalid HTML);
 *   - the To pay bucket exists and is what the API is asked for.
 *
 * Mutation-proven against the component itself (each run, then reverted):
 *   1. `canSend` without the DINE_IN guard — 1 failed, 9 passed. The takeaway
 *      fixture carries a session id ON PURPOSE: the server never sends one
 *      for a bag, so with the honest `null` the session guard hid the channel
 *      guard and this mutant survived. The channel rule is the one under test.
 *   2. `AWAITING_PAYMENT` dropped from STATUS_TABS — 1 failed, 9 passed.
 *
 * NOT provable here, and said so: the footer's `relative z-10` over the
 * stretched overlay. jsdom has no layout and no pseudo-elements, so a tap
 * reaches whichever element it is dispatched to regardless of stacking. The
 * "does not open the drawer" case proves only that the button's handler does
 * not ALSO fire the card's; the stacking itself is checked by eye.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';

const replace = vi.fn();
let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => currentParams,
}));

const list = vi.fn();
const sendToCashier = vi.fn();
const getBill = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  restaurantOrders: { list: (...args: unknown[]) => list(...args) },
  tableSessions: { sendToCashier: (...args: unknown[]) => sendToCashier(...args) },
  billing: { get: (...args: unknown[]) => getBill(...args) },
}));

const printBillView = vi.fn();
vi.mock('@/lib/restaurant/bill-print', () => ({
  printBillView: (...args: unknown[]) => printBillView(...args),
}));

const { OrdersPage } = await import('./orders-page');

function sessionWith(permissions: string[]) {
  return {
    token: 'tok',
    user: {
      id: 'usr_me',
      name: 'Till Operator',
      email: 'till@example.test',
      role: 'CASHIER',
      tenantId: 'tnt_1',
      permissions,
    },
    branchId: 'brn_1',
    registerId: null,
    branchName: 'Main',
    registerName: 'R1',
  } as unknown as Session;
}
const WAITER = sessionWith(['table:close']);
const CASHIER = sessionWith(['payment:collect']);

const ZERO_COUNTS = {
  DRAFT: 0,
  PENDING: 0,
  CONFIRMED: 0,
  IN_PROGRESS: 0,
  READY: 0,
  AWAITING_PAYMENT: 0,
  HANDED_OVER: 0,
  COMPLETED: 0,
  CANCELLED: 0,
};

function row(
  id: string,
  over: Partial<{
    channel: 'DINE_IN' | 'TAKEAWAY';
    unifiedStatus: 'PENDING' | 'READY' | 'AWAITING_PAYMENT';
    sessionId: string | null;
    saleId: string | null;
  }> = {},
) {
  return {
    id,
    channel: 'DINE_IN' as const,
    source: 'POS' as const,
    orderNumber: id.toUpperCase(),
    unifiedStatus: 'READY' as const,
    paymentStatus: 'UNPAID' as const,
    customerName: null,
    customerPhone: null,
    contextLabel: 'T4',
    pickupAt: null,
    createdAt: new Date().toISOString(),
    total: '4850.00',
    saleId: null,
    sessionId: 'ts_' + id,
    itemCount: 1,
    itemPreview: [{ name: 'Kottu', qty: 1 }],
    rounds: [],
    staffUserId: 'usr_me',
    staffName: 'Till Operator',
    ...over,
  };
}

function page(items: ReturnType<typeof row>[]) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: { ...ZERO_COUNTS },
    readyHandoverCount: 0,
    mineCount: items.length,
    allCount: items.length,
    resolvedScope: 'mine' as const,
  };
}

const DINE_IN_READY = row('ord_ready');
const DINE_IN_PENDING = row('ord_pending', { unifiedStatus: 'PENDING' });
// A session id a real bag never has — see the header: it is what makes the
// channel guard, not the session guard, the thing the negative case proves.
const TAKEAWAY_READY = row('ord_bag', { channel: 'TAKEAWAY', sessionId: 'ts_bag' });
const AT_THE_TILL = row('ord_till', { unifiedStatus: 'AWAITING_PAYMENT', saleId: 'sale_1' });

/** The card that carries this order number — the footer is looked up inside it. */
const cardFor = (orderNumber: string) => {
  const el = screen.getByRole('button', { name: `#${orderNumber}` }).closest('[data-testid="order-card"]');
  if (!el) throw new Error(`no card for ${orderNumber}`);
  return el as HTMLElement;
};
const within = async (orderNumber: string) =>
  (await import('@testing-library/react')).within(cardFor(orderNumber));

beforeEach(() => {
  currentParams = new URLSearchParams();
  list.mockResolvedValue(page([DINE_IN_READY, DINE_IN_PENDING, TAKEAWAY_READY, AT_THE_TILL]));
  sendToCashier.mockResolvedValue({ saleId: 'sale_new', session: { status: 'BILLING' } });
  getBill.mockResolvedValue({
    saleId: 'sale_1',
    saleNumber: 'S-000001',
    balanceAmount: '4850.00',
    paymentStatus: 'UNPAID',
  });
  printBillView.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the waiter’s verb — Proceed to pay', () => {
  it('sits on a dine-in READY card, and on no other', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_READY' });

    // POSITIVE
    expect((await within('ORD_READY')).getByRole('button', { name: /Proceed to pay/ })).toBeTruthy();
    // NEGATIVE — not before the kitchen is done, not on a bag, not on a bill
    // that is already at the till.
    expect((await within('ORD_PENDING')).queryByRole('button', { name: /Proceed to pay/ })).toBeNull();
    expect((await within('ORD_BAG')).queryByRole('button', { name: /Proceed to pay/ })).toBeNull();
    expect((await within('ORD_TILL')).queryByRole('button', { name: /Proceed to pay/ })).toBeNull();
  });

  it('is nobody else’s: the till sees no Proceed to pay on the same card', async () => {
    render(<OrdersPage session={CASHIER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_READY' });
    expect(screen.queryByRole('button', { name: /Proceed to pay/ })).toBeNull();
  });

  it('sends the table to the cashier with a fresh key, then refetches the queue', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_READY' });
    const before = list.mock.calls.length;

    fireEvent.click((await within('ORD_READY')).getByRole('button', { name: /Proceed to pay/ }));

    await waitFor(() => expect(sendToCashier).toHaveBeenCalledTimes(1));
    const [, sessionId, body] = sendToCashier.mock.calls[0] as [unknown, string, { idempotencyKey: string }];
    expect(sessionId).toBe('ts_ord_ready');
    expect(body.idempotencyKey).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    // …and it did NOT open the drawer: the button is above the overlay.
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('open='));
  });

  it('the card still opens the drawer from its order number', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    fireEvent.click(await screen.findByRole('button', { name: '#ORD_READY' }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('open=ord_ready'));
    expect(sendToCashier).not.toHaveBeenCalled();
  });
});

describe('the till’s verbs — Print bill and Collect payment', () => {
  it('sit on a dine-in card at the till for a role that can settle, and nowhere else', async () => {
    render(<OrdersPage session={CASHIER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });

    // POSITIVE
    const till = await within('ORD_TILL');
    expect(till.getByRole('button', { name: /Print bill/ })).toBeTruthy();
    expect(till.getByRole('button', { name: /Collect payment/ })).toBeTruthy();
    // NEGATIVE — the READY card is the waiter's moment, not the till's.
    const ready = await within('ORD_READY');
    expect(ready.queryByRole('button', { name: /Print bill/ })).toBeNull();
    expect(ready.queryByRole('button', { name: /Collect payment/ })).toBeNull();
  });

  it('are withheld from the floor (D87 — only the till prints)', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });
    expect(screen.queryByRole('button', { name: /Print bill/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Collect payment/ })).toBeNull();
  });

  it('Print bill fetches the bill and prints it naming the cashier', async () => {
    render(<OrdersPage session={CASHIER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });
    fireEvent.click((await within('ORD_TILL')).getByRole('button', { name: /Print bill/ }));

    await waitFor(() => expect(printBillView).toHaveBeenCalledTimes(1));
    expect(getBill.mock.calls[0]?.[1]).toBe('sale_1');
    const [, view, ctx] = printBillView.mock.calls[0] as [unknown, { saleId: string }, { cashierName: string }];
    expect(view.saleId).toBe('sale_1');
    expect(ctx.cashierName).toBe('Till Operator');
  });

  it('Collect payment opens the tender dialog against the bill’s balance', async () => {
    render(<OrdersPage session={CASHIER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });
    fireEvent.click((await within('ORD_TILL')).getByRole('button', { name: /Collect payment/ }));

    await screen.findByRole('heading', { name: 'Collect payment' });
    expect(screen.getByText(/Bill balance/)).toBeTruthy();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('4850.00');
  });
});

describe('the To pay bucket', () => {
  it('is a tab, and selecting it asks the server for AWAITING_PAYMENT', async () => {
    render(<OrdersPage session={CASHIER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });

    fireEvent.click(screen.getByRole('button', { name: /^To pay/ }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('status=AWAITING_PAYMENT'));
  });

  it('badges a card at the till as To pay', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_TILL' });
    expect((await within('ORD_TILL')).getByText('To pay')).toBeTruthy();
    expect((await within('ORD_READY')).queryByText('To pay')).toBeNull();
  });
});
