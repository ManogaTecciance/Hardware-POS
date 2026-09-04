/**
 * `usePosCatalogue` — server-side paging and search.
 *
 * `GET /products/sellable` has always been keyset-paged (default 100 rows,
 * `nextCursor`) and has always accepted `search`. This hook used neither: one
 * unpaged request, `nextCursor` discarded. A branch with more than 100 sellable
 * products silently lost every row past the hundredth, and search then ran
 * client-side over that truncated set — so an item could be active and still be
 * unfindable at the till.
 *
 * These assertions are made against a spy on the API client rather than the
 * rendered output, because the broken version rendered a perfectly ordinary
 * grid: the defect was in which requests were issued, and only the request log
 * distinguishes fixed from broken. Every case pins both directions — what IS
 * sent and what is NOT — since a hook that stopped fetching entirely would
 * satisfy the negatives alone.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PosCatalogueItem,
  PosCatalogueQuery,
  PosCatalogueResponse,
} from '@/lib/restaurant/pos-catalogue-api';
import type { Session } from '@/lib/session-store';

// ── boundaries ───────────────────────────────────────────────────────────────

const fetchPosCatalogue = vi.fn();
vi.mock('@/lib/restaurant/pos-catalogue-api', () => ({
  fetchPosCatalogue: (...args: unknown[]) => fetchPosCatalogue(...args),
}));

const { usePosCatalogue } = await import('./use-menu-data');
const { normalizeSearchTerm } = await import('@/lib/search-term');

// ── fixtures ─────────────────────────────────────────────────────────────────

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

function item(id: string, name: string): PosCatalogueItem {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    unitPrice: 100,
    prepMinutes: null,
    dietaryTags: [],
    foodType: 'FOOD',
    category: null,
    subcategory: null,
    hasVariants: false,
    variants: [],
    modifierGroups: [],
    stations: [],
    promotions: [],
    stockState: 'UNTRACKED',
  };
}

function page(
  items: PosCatalogueItem[],
  nextCursor: string | null,
  total = items.length,
): PosCatalogueResponse {
  return { items, total, nextCursor };
}

/** The query object passed to the Nth call (0-indexed). */
function queryOf(call: number): PosCatalogueQuery {
  return fetchPosCatalogue.mock.calls[call]?.[1] as PosCatalogueQuery;
}

/** Items the adapter bucketed into the FOOD section — every fixture is FOOD. */
function foodRows(data: { itemsBySection: Map<string, { id: string; name: string }[]> }) {
  return data.itemsBySection.get('__section_food__') ?? [];
}

beforeEach(() => {
  fetchPosCatalogue.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the first page', () => {
  it('asks the server for a bounded page, with no cursor', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Rice')], null));

    const { result } = renderHook(() => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN'));
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(fetchPosCatalogue).toHaveBeenCalledTimes(1);
    const q = queryOf(0);
    expect(q.branchId).toBe('brn_1');
    expect(q.channel).toBe('DINE_IN');
    // Positive: a limit IS sent. The bug was sending none and treating the
    // server's default page as though it were the whole catalogue.
    expect(q.limit).toBe(100);
    expect(q.cursor).toBeUndefined();
    expect(q.search).toBeUndefined();
  });

  it('does not fetch at all without a branch', () => {
    renderHook(() => usePosCatalogue(SESSION, null, 'DINE_IN'));
    expect(fetchPosCatalogue).not.toHaveBeenCalled();
  });
});

describe('paging', () => {
  it('reports more pages, then sends the cursor and appends the rows', async () => {
    fetchPosCatalogue.mockResolvedValueOnce(page([item('p1', 'Rice')], 'CURSOR_1', 2));
    const { result } = renderHook(() => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN'));
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(result.current.hasMore).toBe(true);
    expect(result.current.total).toBe(2);

    fetchPosCatalogue.mockResolvedValueOnce(page([item('p2', 'Kottu')], null, 2));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadedCount).toBe(2));

    expect(queryOf(1).cursor).toBe('CURSOR_1');
    // Appended, not replaced — page one must survive page two.
    expect(foodRows(result.current.data).map((r) => r.name)).toEqual(['Rice', 'Kottu']);
    expect(result.current.hasMore).toBe(false);
  });

  it('is a no-op on the last page', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Rice')], null));
    const { result } = renderHook(() => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN'));
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(result.current.hasMore).toBe(false);
    await act(async () => {
      result.current.loadMore();
    });
    // Negative: no cursor means no request. A hook that fetched regardless
    // would re-request the final page forever.
    expect(fetchPosCatalogue).toHaveBeenCalledTimes(1);
  });

  it('drops an id already loaded rather than rendering it twice', async () => {
    fetchPosCatalogue.mockResolvedValueOnce(page([item('p1', 'Rice')], 'CURSOR_1', 2));
    const { result } = renderHook(() => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN'));
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    // A rename between two page reads can put the same row on both sides of
    // the keyset cursor; a duplicate React key would break the grid.
    fetchPosCatalogue.mockResolvedValueOnce(
      page([item('p1', 'Rice'), item('p2', 'Kottu')], null, 2),
    );
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.hasMore).toBe(false));

    expect(result.current.loadedCount).toBe(2);
    expect(foodRows(result.current.data).map((r) => r.id)).toEqual(['p1', 'p2']);
  });
});

describe('search', () => {
  it('sends the term to the server', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Kottu')], null));
    const { result } = renderHook(() =>
      usePosCatalogue(SESSION, 'brn_1', 'DINE_IN', { search: 'kottu' }),
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(queryOf(0).search).toBe('kottu');
  });

  it('resets paging, so a new term never inherits the old cursor', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Rice')], 'CURSOR_1', 200));
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN', { search }),
      { initialProps: { search: '' } },
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(fetchPosCatalogue).toHaveBeenCalledTimes(2));
    expect(queryOf(1).cursor).toBe('CURSOR_1');

    fetchPosCatalogue.mockResolvedValue(page([item('p9', 'Kottu')], null, 1));
    rerender({ search: 'kottu' });
    await waitFor(() => expect(fetchPosCatalogue).toHaveBeenCalledTimes(3));

    // Negative: a cursor is only meaningful within one filter. Carrying it
    // over would page into the middle of a different result set.
    expect(queryOf(2).search).toBe('kottu');
    expect(queryOf(2).cursor).toBeUndefined();
    await waitFor(() => expect(result.current.loadedCount).toBe(1));
  });

  it('trims the term, and an all-whitespace term is no term at all', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Rice')], null));
    const { result } = renderHook(() =>
      usePosCatalogue(SESSION, 'brn_1', 'DINE_IN', { search: '   ' }),
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(queryOf(0).search).toBeUndefined();
  });
});

describe('failure', () => {
  it('surfaces the error and holds no stale rows', async () => {
    fetchPosCatalogue.mockRejectedValue(new Error('Feature not available'));
    const { result } = renderHook(() => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN'));
    await waitFor(() => expect(result.current.error).toBe('Feature not available'));

    expect(result.current.loadedCount).toBe(0);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.data.menus).toEqual([]);
  });
});

/*
 * Whitespace escapes are built with `String.fromCharCode` rather than written
 * as literals so this block survives being edited through tooling that
 * resolves backslash escapes.
 */
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

describe('term normalisation', () => {
  it('collapses internal whitespace, not just the ends', () => {
    // The server matches with `contains`, so "Fried   Rice" is a substring of
    // nothing: two spaces returned zero rows for a term that plainly exists
    // ("Fried Rice" finds three). Every spelling must reach the server alike.
    expect(normalizeSearchTerm('Fried   Rice')).toBe('Fried Rice');
    expect(normalizeSearchTerm('  Fried Rice  ')).toBe('Fried Rice');
    expect(normalizeSearchTerm('Fried' + TAB + 'Rice')).toBe('Fried Rice');
    expect(normalizeSearchTerm('Fried' + NL + '  Rice')).toBe('Fried Rice');
    expect(normalizeSearchTerm('  Fried ' + TAB + NL + '  Rice  ')).toBe('Fried Rice');
  });

  it('empties a whitespace-only or missing term', () => {
    expect(normalizeSearchTerm('   ')).toBe('');
    expect(normalizeSearchTerm('')).toBe('');
    expect(normalizeSearchTerm(TAB + NL)).toBe('');
    expect(normalizeSearchTerm(undefined)).toBe('');
    expect(normalizeSearchTerm(null)).toBe('');
  });

  it('leaves an already-clean term byte-identical', () => {
    // The negative control: a normaliser that mangled or lowercased every term
    // would satisfy the collapsing cases above and still fail here. Case
    // matters — the server's dietary-tag match is case-sensitive.
    expect(normalizeSearchTerm('Fried Rice')).toBe('Fried Rice');
    expect(normalizeSearchTerm('Veg')).toBe('Veg');
    expect(normalizeSearchTerm('Rice & Curry (Chicken)')).toBe('Rice & Curry (Chicken)');
  });

  it('sends the collapsed term, so spacing cannot change the result set', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Fried Rice')], null));
    const { result } = renderHook(() =>
      usePosCatalogue(SESSION, 'brn_1', 'DINE_IN', { search: 'Fried   Rice' }),
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    expect(queryOf(0).search).toBe('Fried Rice');
  });

  it('does not refetch when only the spacing of a term changes', async () => {
    fetchPosCatalogue.mockResolvedValue(page([item('p1', 'Fried Rice')], null));
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => usePosCatalogue(SESSION, 'brn_1', 'DINE_IN', { search }),
      { initialProps: { search: 'Fried Rice' } },
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(1));
    expect(fetchPosCatalogue).toHaveBeenCalledTimes(1);

    rerender({ search: 'Fried    Rice ' });
    await waitFor(() => expect(result.current.loadedCount).toBe(1));

    // Both spellings normalise to one term, so the effect key is unchanged and
    // no second request goes out.
    expect(fetchPosCatalogue).toHaveBeenCalledTimes(1);
  });
});
