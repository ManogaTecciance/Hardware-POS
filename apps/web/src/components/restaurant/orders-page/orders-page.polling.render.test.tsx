/**
 * The Orders page poll — when it runs, and that it stays SILENT.
 *
 * - Silence (D118, PO): this screen once rang a new-order chime and a
 *   food-ready bell; the PO wants sound in the kitchen alone. Pinned as a
 *   tripwire against the audio module, exercised with exactly the polls
 *   that USED to ring (total growth, ready-count growth) — a re-added
 *   import and call is one line, and this is what catches it.
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

// D118's silence is asserted at the runtime boundary, not at a module the
// screen does not even import: the chime is a Web Audio graph, so a sound —
// this branch's, or one re-added any other way — must construct an
// AudioContext. jsdom has none; the stub is the only one, and it counts.
const audioCtor = vi.fn();
vi.stubGlobal('AudioContext', audioCtor);
vi.stubGlobal('webkitAudioContext', audioCtor);

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
 * chime, the ready bell and the poll read the envelope, never the cards.
 * `ready` is D114's counter-owned READY tally (takeaway + third-party).
 */
function pageOf(total: number, ready = 0) {
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
      READY: ready,
      HANDED_OVER: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    },
    readyHandoverCount: ready,
  };
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  audioCtor.mockReset();
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

/*
 * D118 (PO) — the queue makes NO sound. These are the exact polls that used
 * to ring (an arrival growing the total; a takeaway going READY growing the
 * handover tally), re-run as silence tripwires: the fetches are proven to
 * have happened, and no AudioContext was constructed.
 */
describe('the queue is silent (D118)', () => {
  it('an arriving order changes the count on screen, not the speaker', async () => {
    list.mockResolvedValueOnce(pageOf(3)).mockResolvedValue(pageOf(4));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    await tickPoll();
    await settle(2);
    expect(audioCtor).not.toHaveBeenCalled();
  });

  it('a takeaway going ready moves the Ready tab, not the speaker', async () => {
    list.mockResolvedValueOnce(pageOf(3, 0)).mockResolvedValue(pageOf(3, 1));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await settle(1);

    await tickPoll();
    await settle(2);
    expect(audioCtor).not.toHaveBeenCalled();
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

/*
 * The stub above is only a tripwire if a real chime WOULD trip it. Last in
 * the file on purpose: the chime module caches its context, so this must run
 * after every silence assertion — a fresh module instance proves the
 * constructor is what a sound reaches for.
 */
describe('POSITIVE CONTROL — the stub can hear a real chime', () => {
  it('the real new-order chime constructs an AudioContext', async () => {
    vi.resetModules();
    const { playNewOrderChime } = await import('@/lib/restaurant/new-order-chime');
    playNewOrderChime();
    expect(audioCtor).toHaveBeenCalledTimes(1);
  });
});
