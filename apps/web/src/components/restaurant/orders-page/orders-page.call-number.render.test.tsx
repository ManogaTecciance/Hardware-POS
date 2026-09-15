/**
 * D201 — the queue card is named by its permanent RO- number.
 *
 * D197 led with the call tag ("#47") and kept the RO- beside it, muted; the
 * PO reversed that for the queue and the kitchen: "keep RO, remove # numbers".
 * The card is named `RO-000120` and carries NO call tag; an order minted
 * before D197 reads its `RO-` exactly as it always did; a third-party row
 * reads the partner's reference. The call number still exists and is still
 * said to the guest — on the POS, the KOT paper and the bill.
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

describe('the card is named by its RO- number (D201)', () => {
  it('is "#RO-000120" and carries no call tag anywhere on the card', async () => {
    /*
     * D16: under D197 this case asserted the OPPOSITE — "#47" as the name
     * with the RO- muted beside it. Reversed by decision (D201) and kept as
     * strong: the call tag is asserted absent from the WHOLE card, so a copy
     * moved to another element could not pass.
     */
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#RO-000120' });
    const card = cardNamed('#RO-000120');
    // POSITIVE — the name is the permanent number alone, spelled as every
    // order was before D197…
    expect(card.getByRole('button', { name: '#RO-000120' }).textContent).toBe('#RO-000120');
    // …NEGATIVE — and the call tag appears nowhere on the card.
    expect(card.queryByText(/#47/)).toBeNull();
    expect(card.queryByTestId('order-permanent-number')).toBeNull();
  });

  it('an order minted before D197 reads its RO- exactly as it always did', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#RO-000009' });
    expect(cardNamed('#RO-000009').queryByText(/#\d/)).toBeNull();
  });

  it("a third-party row is named by the partner's reference", async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#UE-9F3K' });
    expect(cardNamed('#UE-9F3K').queryByText(/#\d/)).toBeNull();
  });

  it('MUTATION — a card named by the call tag would fail the first case', async () => {
    // The control: exactly one button per card, and none of them is a bare
    // `#<digits>` — the spelling only the call tag uses.
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: '#RO-000120' });
    const names = screen
      .getAllByTestId('order-card')
      .map((c) => within(c).getAllByRole('button')[0]!.textContent);
    expect(names).toEqual(['#RO-000120', '#RO-000009', '#UE-9F3K']);
  });
});
