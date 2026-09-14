/**
 * D197 — the queue card is named by its call number.
 *
 * `RO-000120` is the permanent identifier and the wrong thing to say across a
 * counter; `#47` restarts every business day and is what the customer was
 * told. The card leads with the tag and keeps the RO- beside it, muted; an
 * order minted before D197 has no call number and reads `#RO-000120` alone,
 * exactly as it did; a third-party row reads the partner's reference.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';
import type { UnifiedOrderView } from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

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

const SESSION = {
  token: 'tok',
  user: {
    id: 'usr_me',
    name: 'Floor',
    email: 'floor@example.test',
    role: 'CASHIER',
    tenantId: 'tnt_1',
    permissions: [],
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
    channel: 'TAKEAWAY',
    source: 'POS',
    orderNumber: 'RO-000120',
    callNumber: 47,
    unifiedStatus: 'IN_PROGRESS',
    paymentStatus: 'UNPAID',
    customerName: 'Nimal',
    customerPhone: null,
    contextLabel: null,
    pickupAt: null,
    createdAt: new Date().toISOString(),
    total: null,
    saleId: null,
    sessionId: null,
    itemCount: 1,
    itemPreview: [{ name: 'Fried Rice', qty: 1 }],
    rounds: [],
    staffUserId: 'usr_me',
    staffName: 'Floor',
    ...over,
  };
}

const TODAY = row('ord_today', {});
const LEGACY = row('ord_legacy', { orderNumber: 'RO-000009', callNumber: null });
const PARTNER = row('ord_ext', {
  channel: 'THIRD_PARTY',
  source: 'UBER_EATS',
  orderNumber: 'UE-9F3K',
  callNumber: null,
  staffUserId: null,
  staffName: null,
});

const cardNamed = (name: string) => {
  const el = screen.getByRole('button', { name }).closest('[data-testid="order-card"]');
  if (!el) throw new Error(`no card named ${name}`);
  return within(el as HTMLElement);
};

beforeEach(() => {
  currentParams = new URLSearchParams();
  list.mockResolvedValue({
    items: [TODAY, LEGACY, PARTNER],
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

describe('the card is named by its call number (D197)', () => {
  it('leads with "#47" and keeps the RO- number beside it, muted', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#47' });
    const card = cardNamed('#47');
    // POSITIVE — the permanent identifier is still on the card…
    expect(card.getByTestId('order-permanent-number').textContent).toBe('RO-000120');
    // NEGATIVE — …but not as the name: the button is the tag alone.
    expect(card.getByRole('button', { name: '#47' }).textContent).toBe('#47');
    expect(card.queryByRole('button', { name: /RO-000120/ })).toBeNull();
  });

  it('an order minted before D197 reads "#RO-…" alone, as it always did', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#RO-000009' });
    const card = cardNamed('#RO-000009');
    // No second, muted copy of the same number under the name.
    expect(card.queryByTestId('order-permanent-number')).toBeNull();
  });

  it('a third-party row is named by the partner\'s reference', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#UE-9F3K' });
    expect(cardNamed('#UE-9F3K').queryByTestId('order-permanent-number')).toBeNull();
  });

  it('MUTATION — a card that printed the RO- number as its name would fail the first case', async () => {
    // The control: with the tag as the name there is exactly one button
    // per card, and none of them is named by a six-digit number.
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#47' });
    const names = screen
      .getAllByTestId('order-card')
      .map((c) => within(c).getAllByRole('button')[0]!.textContent);
    expect(names).toEqual(['#47', '#RO-000009', '#UE-9F3K']);
  });
});
