/**
 * D157 — "My orders / All orders" on the queue.
 *
 * The PO's report: a waiter working the floor could not find their own orders
 * here — the tab has always listed the whole branch. The scope is the server's
 * (the list is paged, so a client-side filter would narrow one page and call it
 * the total), which makes this spec about the three things the SCREEN owns:
 * what it sends, which chip it lights, and whose name it puts on a row.
 *
 * Paired per D30, because each failure looks like the other working:
 *
 *   - "sends nothing on a first load" is what lets the server pick the default,
 *     and is indistinguishable from a dropped parameter unless the chip tap is
 *     also asserted to send one;
 *   - the active chip comes from `resolvedScope` (the server may have chosen),
 *     so it is asserted against a response that chose the OTHER one;
 *   - a name on every row would look like a name on the right rows, so the
 *     operator's own row is asserted to carry none.
 *
 * Mutation-proven, each run against the component itself:
 *   1. `scope` dropped from the API call — 1 failed, 4 passed;
 *   2. the chips lit from the URL (`scope`) instead of `resolvedScope` — 2
 *      failed, 3 passed: a first load lights NEITHER chip, because the URL
 *      carries nothing until the operator taps one;
 *   3. `staffLabel` replaced with `r.staffName` (every row named) — 1 failed,
 *      4 passed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/lib/restaurant/api', () => ({
  restaurantOrders: { list: (...args: unknown[]) => list(...args) },
}));

const { OrdersPage } = await import('./orders-page');

const ME = 'usr_me';

const SESSION = {
  token: 'tok',
  user: {
    id: ME,
    name: 'Nimal Perera',
    email: 'nimal@example.test',
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

function row(id: string, staffUserId: string | null, staffName: string | null) {
  return {
    id,
    channel: 'DINE_IN' as const,
    source: 'POS' as const,
    orderNumber: id.toUpperCase(),
    unifiedStatus: 'CONFIRMED' as const,
    paymentStatus: 'UNPAID' as const,
    customerName: null,
    customerPhone: null,
    contextLabel: 'Table ' + id.slice(-1),
    pickupAt: null,
    createdAt: new Date().toISOString(),
    total: null,
    saleId: null,
    itemCount: 1,
    itemPreview: [{ name: 'Kottu', qty: 1 }],
    staffUserId,
    staffName,
  };
}

/** A response as the server sends it, including what scope it applied. */
function page(opts: {
  items: ReturnType<typeof row>[];
  resolvedScope: 'mine' | 'all';
  mineCount: number;
  allCount: number;
}) {
  return {
    items: opts.items,
    total: opts.items.length,
    page: 1,
    pageSize: 25,
    truncated: false,
    statusCounts: { ...ZERO_COUNTS, CONFIRMED: opts.items.length },
    readyHandoverCount: 0,
    mineCount: opts.mineCount,
    allCount: opts.allCount,
    resolvedScope: opts.resolvedScope,
  };
}

const MINE = row('ord_1', ME, 'Nimal Perera');
const THEIRS = row('ord_2', 'usr_other', 'Sunil Fernando');

/** What the last API call asked for. */
const lastQuery = () => list.mock.calls.at(-1)?.[2] as { scope?: 'mine' | 'all' } | undefined;

beforeEach(() => {
  currentParams = new URLSearchParams();
  list.mockResolvedValue(
    page({ items: [MINE], resolvedScope: 'mine', mineCount: 1, allCount: 2 }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('whose orders the queue shows (D157)', () => {
  it('asks for no scope on a first load, and lights the one the server applied', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    // POSITIVE — nothing sent, so the server is free to default. (It answers
    // "mine" for anyone who has orders of their own; the client cannot know
    // that without asking, which is the whole reason it does not decide.)
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(lastQuery()?.scope).toBeUndefined();

    // …and the chip that lights is the one the RESPONSE named.
    const mine = await screen.findByRole('button', { name: 'My orders · 1' });
    const all = screen.getByRole('button', { name: 'All orders · 2' });
    expect(mine.getAttribute('data-active')).toBe('true');
    expect(all.getAttribute('data-active')).toBe('false');
  });

  it('D157a — lights My orders on the FIRST paint, before the response lands', async () => {
    /*
     * Same defect as the floor plan's, different cause: `appliedScope` is
     * seeded before any response exists, and it was seeded 'all'. So the queue
     * lit All for the length of one fetch and flipped when `resolvedScope`
     * arrived — "for a second it's in all orders, then navigates to my".
     *
     * The response is held open so this is the in-flight paint, then released
     * to prove the chip does not move when the answer agrees.
     */
    let release!: (page: unknown) => void;
    list.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    const mine = await screen.findByRole('button', { name: 'My orders' });
    expect(mine.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'All orders' }).getAttribute('data-active')).toBe(
      'false',
    );
    /*
     * And NO count yet: zero is a real answer at the till, so showing "· 0"
     * before anybody has counted states that answer early. Asserted by the
     * exact names above — a chip carrying a number would not match them.
     */

    await act(async () => {
      release(page({ items: [MINE], resolvedScope: 'mine', mineCount: 1, allCount: 2 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'My orders · 1' }).getAttribute('data-active'),
      ).toBe('true'),
    );
  });

  it('lights All when the response says All — a shared link, or a tap', async () => {
    list.mockResolvedValue(
      page({ items: [MINE, THEIRS], resolvedScope: 'all', mineCount: 1, allCount: 2 }),
    );
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    const all = await screen.findByRole('button', { name: 'All orders · 2' });
    expect(all.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'My orders · 1' }).getAttribute('data-active')).toBe(
      'false',
    );
  });

  it('D157b — an empty My orders offers the branch instead of widening itself', async () => {
    /*
     * The second flicker: the server used to answer "all" for a caller with
     * nothing of their own, so the queue lit Mine (its seeded state) and then
     * moved to All when the response landed. It now stays, which makes the
     * empty list a state the screen has to speak for — hence the count and the
     * button, rather than a silent jump to somebody else's orders.
     */
    list.mockResolvedValue(
      page({ items: [], resolvedScope: 'mine', mineCount: 0, allCount: 36 }),
    );
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    expect(await screen.findByText(/None of this branch.s orders are yours/)).toBeTruthy();
    // NEGATIVE — not the generic "no orders match this filter", which says
    // nothing about where the orders went.
    expect(screen.queryByText('No orders match this filter.')).toBeNull();
    // Still on Mine: the screen did not move the operator.
    expect(screen.getByRole('button', { name: 'My orders · 0' }).getAttribute('data-active')).toBe(
      'true',
    );

    // And the way over is one tap, carrying the count so it is worth taking.
    fireEvent.click(screen.getByRole('button', { name: 'Show all 36 orders' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls.at(-1)![0] as string).toContain('scope=all');
  });

  it('writes the chip into the URL, resetting the page', async () => {
    currentParams = new URLSearchParams('page=3');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'All orders · 2' }));

    // The URL is what a shared link carries, and page 3 of "mine" names
    // different orders than page 3 of the floor's.
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = replace.mock.calls.at(-1)![0] as string;
    expect(url).toContain('scope=all');
    expect(url).not.toContain('page=3');
  });

  it('sends the scope from the URL, so a shared link opens the same list', async () => {
    currentParams = new URLSearchParams('scope=all');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(lastQuery()?.scope).toBe('all'));
  });

  it('names a colleague on their row, and nobody on mine', async () => {
    list.mockResolvedValue(
      page({ items: [MINE, THEIRS], resolvedScope: 'all', mineCount: 1, allCount: 2 }),
    );
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    // POSITIVE — the colleague's row says whose it is…
    await waitFor(() => expect(screen.getByText(/Sunil Fernando/)).toBeTruthy());
    // …NEGATIVE — and my own row does not repeat my own name down the list.
    expect(screen.queryByText(/Nimal Perera/)).toBeNull();
  });
});
