/**
 * The Orders page search box — what actually gets queried.
 *
 * The term goes into the URL and from there to the API, which matches with
 * `contains`. This page normalised nothing at all: not the ends, not the
 * middle. So `"table  4"` was a substring of no order and came back empty for
 * an order that plainly exists, and a stray leading space did the same.
 *
 * Asserted against the URL the page writes rather than the rendered list,
 * because the URL is what carries the term to the server — the list would look
 * identically empty whether the query was wrong or there were genuinely no
 * matches, so it cannot tell fixed from broken.
 *
 * Both directions throughout: a page that wrote nothing to the URL would
 * satisfy the "no redundant write" cases alone, so each is paired with a term
 * that must be written.
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

const searchBox = () => screen.getByPlaceholderText(/Order #, customer, phone, table/);

/** The paginated envelope the endpoint returns, with nothing in it. */
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
  };
}

/** The `search` value of the last URL this page wrote, or null if it wrote none. */
function lastWrittenSearch(): string | null {
  const call = replace.mock.calls.at(-1);
  if (!call) return null;
  const url = String(call[0]);
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return new URLSearchParams(qs).get('search');
}

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  list.mockResolvedValue(emptyPage());
  currentParams = new URLSearchParams();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Type a term and let the 250ms debounce fire. */
async function type(term: string) {
  fireEvent.change(searchBox(), { target: { value: term } });
  await vi.advanceTimersByTimeAsync(300);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the term written to the URL', () => {
  it('collapses internal whitespace', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await type('table  4');

    // `table  4` is a substring of nothing; `table 4` is what the data holds.
    await waitFor(() => expect(lastWrittenSearch()).toBe('table 4'));
  });

  it('collapses a long run, and tabs', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await type('nimal' + String.fromCharCode(9) + '   perera');

    await waitFor(() => expect(lastWrittenSearch()).toBe('nimal perera'));
  });

  it('trims the ends', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await type('   ORD-1024   ');

    await waitFor(() => expect(lastWrittenSearch()).toBe('ORD-1024'));
  });

  it('leaves an already-clean term exactly as typed', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await type('ORD-1024');

    // The negative control: a normaliser that mangled or lowercased every term
    // would satisfy the collapsing cases above and still fail here. Order
    // numbers are case-sensitive to the operator reading one off a docket.
    await waitFor(() => expect(lastWrittenSearch()).toBe('ORD-1024'));
  });
});

describe('what the operator sees while typing', () => {
  it('keeps the raw keystrokes in the box, spaces and all', async () => {
    render(<OrdersPage session={SESSION} branchId="brn_1" />);
    await type('table  4');

    // Normalising the INPUT would delete a space out from under the cursor
    // mid-word. Only the query is cleaned.
    expect((searchBox() as HTMLInputElement).value).toBe('table  4');
  });
});

describe('redundant writes', () => {
  it('does not rewrite the URL when only the spacing changes', async () => {
    currentParams = new URLSearchParams('search=table 4');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    await type('table    4');

    // Both spellings normalise to the term already in the URL, so there is
    // nothing to write — and no second fetch.
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not loop on a trailing space', async () => {
    currentParams = new URLSearchParams('search=4');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    await type('4 ');

    // Comparing the RAW value against the URL would never converge here: `4 `
    // never equals `4`, so the effect would rewrite on every pass.
    expect(replace).not.toHaveBeenCalled();
  });

  it('still writes a genuinely new term', async () => {
    currentParams = new URLSearchParams('search=table 4');
    render(<OrdersPage session={SESSION} branchId="brn_1" />);

    await type('table 5');

    // The half that proves the guard above is not simply blocking everything.
    await waitFor(() => expect(lastWrittenSearch()).toBe('table 5'));
  });
});
