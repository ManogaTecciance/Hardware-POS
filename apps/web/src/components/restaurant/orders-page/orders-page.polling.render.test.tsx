/**
 * The Orders page poll — when it runs and when it rings.
 *
 * Two behaviours share the 8 s interval, and both are asserted at their
 * boundaries rather than through the DOM:
 *
 * - The new-order chime. Asserted against the chime module, because sound is
 *   the entire output — nothing in the DOM changes when it fires. Every
 *   "rings" case is paired with a "stays silent" case (first load, an
 *   unchanged total, a filter switch): a chime wired to "any response" would
 *   pass the positive case alone and ding all shift.
 *
 * - Visibility gating. Asserted against the fetch mock's call count, because
 *   a poll that never pauses and one that never resumes render the same
 *   grid — only the calls tell them apart. Paired both ways: hidden must
 *   stop the interval, and becoming visible again must refetch at once
 *   rather than waiting out the remainder of an interval.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';

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
}));

const chime = vi.fn();
vi.mock('@/lib/restaurant/new-order-chime', () => ({
  playNewOrderChime: () => chime(),
}));

const { OrdersPage } = await import('./orders-page');

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

/**
 * The paginated envelope with `total` orders in it. Rows stay empty — the
 * chime and the poll read the envelope, never the cards.
 */
function pageOf(total: number) {
  return {
    items: [],
    total,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: {
      DRAFT: 0,
      PENDING: total,
      CONFIRMED: 0,
      IN_PROGRESS: 0,
      READY: 0,
      HANDED_OVER: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    },
  };
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  chime.mockReset();
  currentParams = new URLSearchParams();
  visibility = 'visible';
  // jsdom pins visibilityState to 'visible'; the poll gate needs it movable.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Let one full 8 s poll interval elapse (and its fetch settle). */
async function tickPoll() {
  await vi.advanceTimersByTimeAsync(8000);
}

/** Wait until the endpoint has been hit exactly `calls` times. */
async function settle(calls: number) {
  await waitFor(() => expect(list).toHaveBeenCalledTimes(calls));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the new-order chime', () => {
  it('stays silent on the first load, whatever it brings', async () => {
    list.mockResolvedValue(pageOf(7));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    // Seven orders on open is a queue being looked at, not seven arrivals.
    expect(chime).not.toHaveBeenCalled();
  });

  it('rings when a poll finds more orders under the same filters', async () => {
    list.mockResolvedValueOnce(pageOf(3)).mockResolvedValue(pageOf(4));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    await tickPoll();
    await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
  });

  it('stays silent when the poll brings the same total back', async () => {
    list.mockResolvedValue(pageOf(3));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    await tickPoll();
    await settle(2);
    expect(chime).not.toHaveBeenCalled();
  });

  it('stays silent when the jump comes from switching filters', async () => {
    list.mockResolvedValueOnce(pageOf(3)).mockResolvedValue(pageOf(40));
    currentParams = new URLSearchParams('status=PENDING');
    const view = render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    // Pending (3) → All (40): a bigger number, but no order arrived. A chime
    // keyed on the total alone would ring on every widening tab switch.
    currentParams = new URLSearchParams();
    view.rerender(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(2);

    expect(chime).not.toHaveBeenCalled();
  });
});

describe('polling while hidden', () => {
  it('does not poll a hidden tab', async () => {
    list.mockResolvedValue(pageOf(1));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tickPoll();
    await tickPoll();

    // Two full intervals, zero fetches: an Orders tab forgotten behind the
    // POS must not keep hitting the API all shift.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refetches the moment the tab is visible again', async () => {
    list.mockResolvedValue(pageOf(1));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tickPoll();
    expect(list).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));

    // No 8 s wait: the catch-up fetch fires on the event itself, so the
    // operator is never reading rows as stale as their time away.
    await settle(2);
  });
});
