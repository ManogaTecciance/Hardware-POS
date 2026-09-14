/**
 * D154 — a Completed tab, and All Orders is the live queue.
 *
 * Three things the SCREEN owns:
 *   - the strip: Completed is present, Handed over is gone (both halves —
 *     a strip that merely appended a tab passes only the first);
 *   - what it asks for: the default tab sends `OUTSTANDING`, the Completed
 *     tab writes `status=DONE` to the URL and the API receives `DONE`;
 *   - the counts: All = everything minus the finished rows, Completed = the
 *     finished rows, and a plain tab still reads its own status.
 *
 * Mutation-proven (run, then reverted):
 *   1. the All tab sending `status` through unchanged (no OUTSTANDING mapping)
 *      — "the default load asks for the live queue" fails (1 failed, 4 passed);
 *   2. the All count summing every status (no `- done`) — the counts case
 *      fails (1 failed, 4 passed).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function page(statusCounts: Record<string, number>) {
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
      AWAITING_PAYMENT: 0,
      HANDED_OVER: 0,
      COMPLETED: 0,
      CANCELLED: 0,
      ...statusCounts,
    },
    readyHandoverCount: 0,
    mineCount: 0,
    allCount: 0,
    resolvedScope: 'all' as const,
  };
}

/** The query object of the LAST api call. */
const lastQuery = () => (list.mock.calls.at(-1)?.[2] ?? {}) as { status?: string };

/** The strip's tab by its label, with its count badge read off it. */
const tab = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}\\s`) });
const countOf = (label: string) => Number(tab(label).textContent!.replace(label, '').trim());

beforeEach(() => {
  currentParams = new URLSearchParams();
  list.mockResolvedValue(page({}));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Completed tab (D154)', () => {
  it('is on the strip, and Handed over is not', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });
    expect(screen.queryByRole('button', { name: /Handed over/ })).toBeNull();
    // The rest of the lifecycle is still there, in order.
    for (const label of ['All Orders', 'Pending', 'Preparing', 'Ready', 'To pay', 'Cancelled']) {
      expect(tab(label)).toBeTruthy();
    }
  });

  it('the default load asks for the live queue, not for everything', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });
    expect(lastQuery().status).toBe('OUTSTANDING');
    // …and the URL stays clean: no ?status for the default tab.
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('status='));
  });

  it('asks for DONE when Completed is tapped, and writes it to the URL', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });

    fireEvent.click(tab('Completed'));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('status=DONE'));

    // The page re-reads the URL; simulate the router landing on it.
    currentParams = new URLSearchParams('status=DONE');
    cleanup();
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });
    expect(lastQuery().status).toBe('DONE');
  });

  it('a plain status tab still asks for exactly that status', async () => {
    currentParams = new URLSearchParams('status=READY');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });
    expect(lastQuery().status).toBe('READY');
  });

  it('counts All as the live queue and Completed as the finished rows', async () => {
    list.mockResolvedValue(
      page({ PENDING: 3, READY: 2, AWAITING_PAYMENT: 1, COMPLETED: 4, HANDED_OVER: 5, CANCELLED: 1 }),
    );
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await screen.findByRole('button', { name: /^Completed\s/ });

    expect(countOf('Completed')).toBe(9); // 4 paid tables + 5 handed-over bags
    expect(countOf('All Orders')).toBe(7); // 3 + 2 + 1 + 1 — the finished nine are not here
    expect(countOf('Cancelled')).toBe(1);
  });
});
