/**
 * The Orders page pager.
 *
 * The endpoint used to take a `limit` (default 100) and return a bare array —
 * a ceiling, not paging. Past the hundredth order nothing was reachable and
 * nothing on screen said so, which is the failure this covers.
 *
 * Two things are asserted, and they are different: what the page ASKS the
 * server for (the `page` argument, and the URL it writes), and what it SHOWS.
 * Counting rendered cards cannot distinguish "page 2 was requested" from
 * "page 1 was re-requested and happened to return different rows".
 *
 * Every case is paired with its negative, since a pager that never rendered,
 * or never advanced, would satisfy half of these on its own.
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
    email: 'c@example.test',
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
  HANDED_OVER: 0,
  COMPLETED: 0,
  CANCELLED: 0,
};

function order(id: string) {
  return {
    id,
    channel: 'TAKEAWAY',
    source: 'POS',
    orderNumber: id,
    unifiedStatus: 'PENDING',
    paymentStatus: 'UNPAID',
    customerName: null,
    customerPhone: null,
    contextLabel: id,
    pickupAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    total: '100.00',
    saleId: null,
    itemCount: 1,
    itemPreview: [],
  };
}

function pageOf(count: number, total: number, over: Record<string, unknown> = {}) {
  return {
    items: Array.from({ length: count }, (_, i) => order('ORD-' + i)),
    total,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: { ...ZERO_COUNTS, PENDING: total },
    ...over,
  };
}

/** The query the component asked the API for on its most recent call. */
const requestedQuery = () =>
  list.mock.calls.at(-1)?.[2] as { page?: number; pageSize?: number } | undefined;

const requestedPage = () => requestedQuery()?.page;

/** The `page` in the last URL the component wrote. */
function writtenPage(): string | null {
  const call = replace.mock.calls.at(-1);
  if (!call) return null;
  const url = String(call[0]);
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return new URLSearchParams(qs).get('page');
}

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  list.mockResolvedValue(pageOf(25, 80));
  currentParams = new URLSearchParams();
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('what the page asks the server for', () => {
  it('requests page 1 by default', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    expect(requestedPage()).toBe(1);
  });

  it('requests the page named in the URL', async () => {
    currentParams = new URLSearchParams('page=3');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // The URL is the source of truth, so a refresh or a shared link lands on
    // the same page — the reason paging is not component state.
    expect(requestedPage()).toBe(3);
  });
});

describe('the pager control', () => {
  it('appears once there is more than one page, and says where you are', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    expect(await screen.findByText(/Showing 1–25 of 80 orders/)).toBeTruthy();
    expect(screen.getByText('Page 1 of 4')).toBeTruthy();
  });

  it('is absent when everything fits on one page', async () => {
    list.mockResolvedValue(pageOf(4, 4));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // The negative half: a pager that always rendered would pass the case
    // above and clutter every short list.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('advances, and writes the new page to the URL', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect(writtenPage()).toBe('2');
  });

  it('cannot go back from the first page', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    const prev = (await screen.findByRole('button', { name: 'Previous' })) as HTMLButtonElement;

    expect(prev.disabled).toBe(true);
  });

  it('cannot go past the last page', async () => {
    currentParams = new URLSearchParams('page=4');
    list.mockResolvedValue(pageOf(5, 80, { page: 4 }));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    const next = (await screen.findByRole('button', { name: 'Next' })) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByText('Page 4 of 4')).toBeTruthy();
    expect(screen.getByText(/Showing 76–80 of 80 orders/)).toBeTruthy();
  });
});

describe('changing a filter', () => {
  it('returns to page 1 rather than stranding the reader', async () => {
    currentParams = new URLSearchParams('page=3');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Ready/ }));

    // Staying on page 3 of a status that has one page shows an empty grid
    // under a full tab count, which reads as "the orders vanished".
    expect(writtenPage()).toBeNull();
  });

  it('keeps the page when only the drawer opens', async () => {
    currentParams = new URLSearchParams('page=2');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByText('#ORD-0');

    fireEvent.click(screen.getByText('#ORD-0'));

    // Opening an order is not a filter; closing the drawer must not dump the
    // reader back to page 1.
    expect(writtenPage()).toBe('2');
  });
});

describe('counts come from the server, not the page of rows', () => {
  it('reports the whole result set, not the 25 rows in hand', async () => {
    list.mockResolvedValue(pageOf(25, 80));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // Counting `rows` would say 25 — the page length — for a branch with 80
    // pending orders, and nothing on screen would reveal the difference.
    expect(await screen.findByText(/of 80 orders/)).toBeTruthy();
    /*
     * Two places show it — the Pending metric tile and the Pending tab pill —
     * and both used to count `rows`. Asserting on both is the point: either
     * one still counting the page would show 25 here.
     */
    expect(screen.getAllByText('80').length).toBeGreaterThanOrEqual(2);
  });

  it('warns when the server could not scan the whole set', async () => {
    list.mockResolvedValue(pageOf(25, 1000, { truncated: true }));
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    expect(await screen.findByText(/Narrow the date range or filters/)).toBeTruthy();
  });

  it('says nothing about narrowing when the scan was complete', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    expect(screen.queryByText(/Narrow the date range or filters/)).toBeNull();
  });
});

describe('the page size comes from the server', () => {
  it('does the pager arithmetic with the size the server actually used', async () => {
    // The page sends no `pageSize`, so the server's default decides it. A
    // second copy held on the client would divide by the wrong number the
    // moment that default changed.
    list.mockResolvedValue({
      ...pageOf(50, 80),
      pageSize: 50,
      items: Array.from({ length: 50 }, (_, i) => order('ORD-' + i)),
    });
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    expect(await screen.findByText(/Showing 1–50 of 80 orders/)).toBeTruthy();
    // 80 over 50 is two pages. A hardcoded 25 would say four.
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });

  it('hides the pager when the server returned everything in one page', async () => {
    list.mockResolvedValue({
      ...pageOf(40, 40),
      pageSize: 50,
      items: Array.from({ length: 40 }, (_, i) => order('ORD-' + i)),
    });
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // 40 of 40 fits one 50-row page. Against a hardcoded 25 this would render
    // a pager claiming two pages over a complete list.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
});

describe('the request names its page size', () => {
  it('sends pageSize on every call, not just the page', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    // Left to the server's default it was an unstated agreement between two
    // files, and invisible in devtools. Naming it puts the screen's intent in
    // the request.
    expect(requestedQuery()?.pageSize).toBe(25);
  });

  it('still names it when paging', async () => {
    currentParams = new URLSearchParams('page=2');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    expect(requestedQuery()).toMatchObject({ page: 2, pageSize: 25 });
  });

  it('defers to the size the server actually used, not the one it asked for', async () => {
    // The server clamps to 1..100. If it hands back something other than what
    // was requested, the arithmetic has to follow the response — otherwise the
    // pager counts pages that do not exist.
    list.mockResolvedValue({
      ...pageOf(50, 80),
      pageSize: 50,
      items: Array.from({ length: 50 }, (_, i) => order('ORD-' + i)),
    });
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    expect(requestedQuery()?.pageSize).toBe(25);
    // Asked for 25, served 50 — two pages, not four.
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
  });
});
