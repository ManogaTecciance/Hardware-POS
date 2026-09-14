/**
 * D153a — the queue card shows each round's kitchen state.
 *
 * A two-round table (fried rice up, milkshake still on the pass) used to read
 * a bare "Preparing". The order-level badge is right — the order is not READY
 * until every round is, and that is what gates Proceed to pay — but the card
 * hid WHY. Now it lists the rounds.
 *
 * Paired per D30:
 *   - the half-ready row shows Round 1 · Ready AND Round 2 · Preparing, its
 *     badge stays Preparing, and Proceed to pay is ABSENT;
 *   - the all-ready row shows both rounds Ready and Proceed to pay PRESENT —
 *     a card that always drew the button, or never did, fails one half;
 *   - a third-party row (no rounds of ours) keeps the item preview and draws
 *     no round lines, so the lines are proven scoped rather than unconditional.
 *
 * Mutation-proven (run, then reverted): every line reading ROUND 1's state
 * (`r.rounds[0].status` in place of `round.status`) — the half-ready case
 * fails, 1 failed / 3 passed. That is the mutant that matters: a card that
 * restates one state down every line is exactly the bare "Preparing" this
 * record replaces, one level down.
 *
 * NOT a proof, and said so: keying the list on `itemPreview.length` instead
 * of `rounds.length` survives, because on every real row the two are empty
 * together (a third-party row persists no items; a first-party row's items
 * arrive with their round). The third-party case below is a scoping check,
 * not a mutation catcher.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';
import type { UnifiedOrderView } from '@/lib/restaurant/types';

const replace = vi.fn();
let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => currentParams,
}));

const list = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  restaurantOrders: { list: (...args: unknown[]) => list(...args) },
  tableSessions: { sendToCashier: vi.fn() },
  billing: { get: vi.fn() },
}));

const { OrdersPage } = await import('./orders-page');

const WAITER = {
  token: 'tok',
  user: {
    id: 'usr_me',
    name: 'Floor',
    email: 'floor@example.test',
    role: 'CASHIER',
    tenantId: 'tnt_1',
    permissions: ['table:close'],
  },
  branchId: 'brn_1',
  registerId: null,
  branchName: 'Main',
  registerName: 'R1',
} as unknown as Session;

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

function row(id: string, over: Partial<UnifiedOrderView>): UnifiedOrderView {
  return {
    id,
    channel: 'DINE_IN',
    source: 'POS',
    orderNumber: id.toUpperCase(),
    unifiedStatus: 'IN_PROGRESS',
    paymentStatus: 'UNPAID',
    customerName: null,
    customerPhone: null,
    contextLabel: 'T4',
    pickupAt: null,
    createdAt: new Date().toISOString(),
    total: null,
    saleId: null,
    sessionId: 'ts_' + id,
    itemCount: 2,
    itemPreview: [
      { name: 'Fried Rice', qty: 1 },
      { name: 'Milkshake', qty: 1 },
    ],
    rounds: [],
    staffUserId: 'usr_me',
    staffName: 'Floor',
    ...over,
  };
}

const HALF_READY = row('ord_half', {
  unifiedStatus: 'IN_PROGRESS',
  rounds: [
    { roundNumber: 1, status: 'READY', items: [{ name: 'Fried Rice', qty: 1 }] },
    { roundNumber: 2, status: 'IN_PROGRESS', items: [{ name: 'Milkshake', qty: 1 }] },
  ],
});
const ALL_READY = row('ord_all', {
  unifiedStatus: 'READY',
  rounds: [
    { roundNumber: 1, status: 'READY', items: [{ name: 'Fried Rice', qty: 1 }] },
    { roundNumber: 2, status: 'READY', items: [{ name: 'Milkshake', qty: 1 }] },
  ],
});
const THIRD_PARTY = row('ord_ext', {
  channel: 'THIRD_PARTY',
  source: 'UBER_EATS',
  unifiedStatus: 'IN_PROGRESS',
  sessionId: null,
  itemCount: 0,
  itemPreview: [],
  rounds: [],
  staffUserId: null,
  staffName: null,
  total: '1200.00',
});

const cardFor = (orderNumber: string) => {
  const el = screen.getByRole('button', { name: `#${orderNumber}` }).closest('[data-testid="order-card"]');
  if (!el) throw new Error(`no card for ${orderNumber}`);
  return within(el as HTMLElement);
};

beforeEach(() => {
  currentParams = new URLSearchParams();
  list.mockResolvedValue({
    items: [HALF_READY, ALL_READY, THIRD_PARTY],
    total: 3,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: { ...ZERO_COUNTS },
    readyHandoverCount: 0,
    mineCount: 3,
    allCount: 3,
    resolvedScope: 'all',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('round lines on the card (D153a)', () => {
  it('shows which round is up and which is not, and holds Proceed to pay back', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_HALF' });
    const card = cardFor('ORD_HALF');
    const lines = within(card.getByTestId('round-lines')).getAllByRole('listitem');
    expect(lines).toHaveLength(2);

    // POSITIVE — each round, its contents, its own state.
    expect(lines[0]!.textContent).toContain('Round 1');
    expect(lines[0]!.textContent).toContain('1× Fried Rice');
    expect(within(lines[0]!).getByText('Ready')).toBeTruthy();
    expect(lines[1]!.textContent).toContain('Round 2');
    expect(lines[1]!.textContent).toContain('1× Milkshake');
    expect(within(lines[1]!).getByText('Preparing')).toBeTruthy();
    // NEGATIVE — the order is not ready, and says so, and offers no pay.
    expect(card.queryByRole('button', { name: /Proceed to pay/ })).toBeNull();
  });

  it('shows every round Ready and offers Proceed to pay once the kitchen is done', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_ALL' });
    const card = cardFor('ORD_ALL');
    const lines = within(card.getByTestId('round-lines')).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]!).getByText('Ready')).toBeTruthy();
    expect(within(lines[1]!).getByText('Ready')).toBeTruthy();
    expect(card.getByRole('button', { name: /Proceed to pay/ })).toBeTruthy();
  });

  it('keeps the item preview, and draws no round lines, on a third-party row', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_EXT' });
    const card = cardFor('ORD_EXT');
    expect(card.queryByTestId('round-lines')).toBeNull();
    expect(card.queryByText(/Round 1/)).toBeNull();
  });

  it('CONTROL — the round lines are the item preview’s replacement, not an addition', async () => {
    render(<OrdersPage session={WAITER} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#ORD_HALF' });
    // With rounds present the "2 items — …" preview line is not also drawn.
    expect(cardFor('ORD_HALF').queryByText(/2 items —/)).toBeNull();
  });
});
