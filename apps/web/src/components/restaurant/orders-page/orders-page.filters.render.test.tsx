/**
 * The Filters panel — payment status and date range, the follow-up slice the
 * stub note promised.
 *
 * Asserted at both boundaries the panel drives:
 * - the URL it writes (what a bookmark carries), and
 * - the query the API is called with (what actually filters — dates must
 *   leave as start-of-day/END-of-day instants, or the `to` day filters
 *   itself out).
 *
 * Paired per D30 throughout: every "sends X" has a "does not send X when
 * inactive" twin, and the removed stub copy is asserted ABSENT beside the
 * real controls asserted PRESENT — one half alone also describes the old
 * page or a blank one.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function emptyPage() {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: {
      DRAFT: 0,
      PENDING: 0,
      CONFIRMED: 0,
      IN_PROGRESS: 0,
      READY: 0,
      HANDED_OVER: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    },
    readyHandoverCount: 0,
  };
}

/** The query object of the LAST api call. */
function lastQuery(): Record<string, unknown> {
  const call = list.mock.calls.at(-1);
  return (call?.[2] ?? {}) as Record<string, unknown>;
}

/** The query params of the last URL the page wrote. */
function lastUrlParams(): URLSearchParams {
  const call = replace.mock.calls.at(-1);
  const url = String(call?.[0] ?? '');
  return new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
}

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  list.mockResolvedValue(emptyPage());
  currentParams = new URLSearchParams();
});

afterEach(cleanup);

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /filters/i }));

// ─────────────────────────────────────────────────────────────────────────────

describe('the Filters panel replaces the stub', () => {
  it('shows the real controls and not the "stubbed" note', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    openPanel();
    // POSITIVE — the controls exist…
    expect(screen.getByRole('button', { name: 'Any payment' })).toBeTruthy();
    expect(screen.getByLabelText('From date')).toBeTruthy();
    expect(screen.getByLabelText('To date')).toBeTruthy();
    // …NEGATIVE — and the pilot stub copy is gone.
    expect(screen.queryByText(/stubbed for the pilot/i)).toBeNull();
  });

  it('does not send payment or dates while nothing is picked', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    const q = lastQuery();
    expect(q.paymentStatus).toBe('ALL'); // the client api skips 'ALL'
    expect(q.from).toBeUndefined();
    expect(q.to).toBeUndefined();
  });
});

describe('payment status', () => {
  it('picking Paid writes the URL, and the URL drives the API call', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Paid' }));
    expect(lastUrlParams().get('payment')).toBe('PAID');

    // The page is URL-driven: simulate the router echoing the write back.
    currentParams = new URLSearchParams('payment=PAID');
    cleanup();
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(lastQuery().paymentStatus).toBe('PAID'));
  });

  it('a mangled payment param degrades to All, not to a bad request', async () => {
    currentParams = new URLSearchParams('payment=BANANAS');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(lastQuery().paymentStatus).toBe('ALL');
  });
});

describe('date range', () => {
  it('sends from as the START of its day and to as the END of its day', async () => {
    currentParams = new URLSearchParams('from=2026-09-01&to=2026-09-07');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    const q = lastQuery();
    // Local-time instants: the operator's day, converted once, here.
    expect(q.from).toBe(new Date('2026-09-01T00:00:00').toISOString());
    expect(q.to).toBe(new Date('2026-09-07T23:59:59.999').toISOString());
  });

  it('picking a from later than to drags to along instead of showing an impossible range', async () => {
    currentParams = new URLSearchParams('from=2026-09-01&to=2026-09-03');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-05' } });
    const url = lastUrlParams();
    expect(url.get('from')).toBe('2026-09-05');
    expect(url.get('to')).toBe('2026-09-05');
  });

  it('a garbage date param is treated as unset', async () => {
    currentParams = new URLSearchParams('from=last-tuesday');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(lastQuery().from).toBeUndefined();
  });

  it('Clear filters drops payment and both dates from the URL', async () => {
    currentParams = new URLSearchParams('payment=PAID&from=2026-09-01&to=2026-09-07');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // The panel opened itself for the active filters (a closed panel over an
    // active filter reads as a broken list).
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    const url = lastUrlParams();
    expect(url.get('payment')).toBeNull();
    expect(url.get('from')).toBeNull();
    expect(url.get('to')).toBeNull();
  });
});
