/**
 * `PosMenuBrowser` — the two modes, rendered.
 *
 * The component now serves two callers with different contracts, and the
 * failure mode of confusing them is silent in both directions:
 *
 *   - **Server mode** (`serverQuery`, the restaurant catalogue). `data` is
 *     already the match set, and the server matched on dietary tags and
 *     subcategory name — fields no card renders. Re-running the old
 *     name/description filter here would DISCARD those hits, so a tag search
 *     would come back empty while the server had found rows.
 *   - **Client mode** (no `serverQuery`, the legacy admin-menu chain). The
 *     whole tree is already loaded and the substring filter is the only one
 *     there is. It must keep working exactly as before.
 *
 * So every case asserts both what is shown and what is not: a component that
 * rendered every row always would pass the server-mode cases alone, and one
 * that rendered nothing would pass the negatives alone.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PosCatalogueItem } from '@/lib/restaurant/pos-catalogue-api';

import { PosMenuBrowser, type PosBrowserServerQuery } from './pos-menu-browser';
import { catalogueToMenuData } from './use-menu-data';

// ── fixtures ─────────────────────────────────────────────────────────────────

function item(id: string, name: string, description: string | null = null): PosCatalogueItem {
  return {
    id,
    name,
    description,
    imageUrl: null,
    unitPrice: 250,
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
  };
}

/** Built through the real adapter, so the fixture matches production shape. */
const MENU = catalogueToMenuData([
  item('p1', 'Rice and Curry', 'House plate'),
  item('p2', 'Kottu'),
]);

const EMPTY = catalogueToMenuData([]);

function serverQuery(over: Partial<PosBrowserServerQuery> = {}): PosBrowserServerQuery {
  return {
    search: '',
    onSearchChange: vi.fn(),
    appliedSearch: '',
    hasMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    total: 2,
    loadedCount: 2,
    ...over,
  };
}

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('server mode', () => {
  it('renders exactly the rows the server returned, without re-filtering them', () => {
    // "vegan" matches nothing in either name or description. The server matched
    // it on a dietary tag; the component must not second-guess that.
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ search: 'vegan', appliedSearch: 'vegan', total: 2 })}
      />,
    );

    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.getByText('Kottu')).toBeTruthy();
    expect(screen.queryByText(/No items match/)).toBeNull();
  });

  it('reports the server total, not just the loaded page', () => {
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ search: 'r', appliedSearch: 'r', total: 47 })}
      />,
    );

    expect(screen.getByText(/Showing 2 of 47 results/)).toBeTruthy();
  });

  it('says no match — never "no menu configured" — when a search returns nothing', () => {
    render(
      <PosMenuBrowser
        data={EMPTY}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ search: 'zzz', appliedSearch: 'zzz', total: 0, loadedCount: 0 })}
      />,
    );

    expect(screen.getByText('No items match "zzz".')).toBeTruthy();
    // The bug this guards: an empty result set collapses `menus`, which used to
    // trip the "ask an administrator" branch and tell a cashier the branch had
    // no menu at all.
    expect(screen.queryByText(/No active menu is configured/)).toBeNull();
  });

  it('still reports a genuinely unconfigured branch when nothing is being searched', () => {
    render(
      <PosMenuBrowser
        data={EMPTY}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ total: 0, loadedCount: 0 })}
      />,
    );

    expect(screen.getByText(/No active menu is configured/)).toBeTruthy();
  });

  it('holds the section view while a typed term is still being debounced', () => {
    // `search` has moved but `appliedSearch` has not: `data` is still the
    // unfiltered page, so flipping to "results" would read as "everything
    // matched".
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ search: 'kot', appliedSearch: '' })}
      />,
    );

    expect(screen.getByText('Section')).toBeTruthy();
    expect(screen.queryByText(/Showing .* results? for/)).toBeNull();
  });

  it('does not own the input — typing is reported upward', () => {
    const onSearchChange = vi.fn();
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ onSearchChange })}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Search menu/), { target: { value: 'kot' } });
    expect(onSearchChange).toHaveBeenCalledWith('kot');
  });
});

describe('the load-more control', () => {
  it('appears only when the server has another page, and asks for it', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ hasMore: false })}
      />,
    );
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();

    rerender(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ hasMore: true, onLoadMore, total: 120, loadedCount: 100 })}
      />,
    );

    const button = screen.getByRole('button', { name: /Load more/ });
    expect(button.textContent).toContain('100 of 120');
    fireEvent.click(button);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a page is in flight', () => {
    const onLoadMore = vi.fn();
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ hasMore: true, loadingMore: true, onLoadMore })}
      />,
    );

    const button = screen.getByRole('button', { name: /Loading/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('never appears for a caller that has no server paging', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
  });
});

describe('client mode (legacy, unchanged)', () => {
  it('still filters locally on name, and hides what does not match', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/Search menu/), { target: { value: 'kottu' } });

    expect(screen.getByText('Kottu')).toBeTruthy();
    // The positive above would hold even if filtering had been dropped; this
    // is the half that proves it still runs.
    expect(screen.queryByText('Rice and Curry')).toBeNull();
    expect(screen.getByText(/Showing 1 result across every/)).toBeTruthy();
  });

  it('still matches on description', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/Search menu/), { target: { value: 'house' } });

    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.queryByText('Kottu')).toBeNull();
  });

  it('reports no match rather than an unconfigured branch', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/Search menu/), { target: { value: 'zzz' } });

    expect(screen.getByText('No items match "zzz".')).toBeTruthy();
    expect(screen.queryByText(/No active menu is configured/)).toBeNull();
  });
});

describe('the search input', () => {
  it('carries an accessible name that survives typing', () => {
    // The placeholder is not an accessible name: it disappears the moment the
    // cashier types, leaving the field unlabelled for assistive tech.
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    expect(screen.getByLabelText('Search the menu')).toBeTruthy();
  });

  it('never promises to search stations, in either mode', () => {
    const { rerender } = render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    const client = screen.getByLabelText('Search the menu') as HTMLInputElement;
    // Client mode matches name and description, and nothing else.
    expect(client.placeholder).toContain('descriptions');
    expect(client.placeholder).not.toContain('station');

    rerender(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery()}
      />,
    );
    const server = screen.getByLabelText('Search the menu') as HTMLInputElement;
    // Server mode matches name, dietary tags and subcategory.
    expect(server.placeholder).toContain('tags');
    expect(server.placeholder).toContain('categories');
    expect(server.placeholder).not.toContain('station');
  });

  it('offers a clear control only once there is something to clear', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'kottu' } });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  it('clearing empties the field and restores the section grid', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    const input = screen.getByLabelText('Search the menu') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'kottu' } });
    // The section row now stays put during a search — see the block below.
    expect(screen.getByText('Section')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(input.value).toBe('');
    // Back to browsing, which is the point of clearing at a till.
    expect(screen.getByText('Section')).toBeTruthy();
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
  });

  it('reports the clear upward in server mode rather than swallowing it', () => {
    const onSearchChange = vi.fn();
    render(
      <PosMenuBrowser
        data={MENU}
        loading={false}
        onPick={vi.fn()}
        serverQuery={serverQuery({ search: 'kottu', appliedSearch: 'kottu', onSearchChange })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    // The parent owns the term in server mode; clearing locally would leave
    // the field and the loaded rows disagreeing.
    expect(onSearchChange).toHaveBeenCalledWith('');
  });
});

describe('the section chips during a search', () => {
  it('stays on screen instead of being replaced by the result count', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });

    // Both, not either: the row used to be swapped out for the count, which
    // left no way back to browsing and no way to narrow a broad term.
    expect(screen.getByText('Section')).toBeTruthy();
    expect(screen.getByText(/Showing 1 result across every/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Food' })).toBeTruthy();
  });

  it('leaves every chip unselected to begin with, so results span all sections', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });

    // Search has always spanned every section; no chip being active is what
    // keeps that, rather than silently scoping results to one of them.
    for (const label of ['Food']) {
      expect(screen.getByRole('button', { name: label }).getAttribute('data-active')).toBeNull();
    }
    expect(screen.getByText(/across every/)).toBeTruthy();
  });

  it('offers no All chip, in either mode', () => {
    render(<PosMenuBrowser data={MENU} loading={false} onPick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
    // Positive control: the row itself is still there, so the absence above is
    // the All chip being gone, not the chips failing to render.
    expect(screen.getByRole('button', { name: 'Food' })).toBeTruthy();
  });

  it('narrows the results when a section chip is tapped', () => {
    const beverage = catalogueToMenuData([
      { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
      { ...item('p3', 'Curry Leaf Soda'), foodType: 'BEVERAGE' as const },
    ]);
    render(<PosMenuBrowser data={beverage} loading={false} onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });

    // All: both sections' matches.
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.getByText('Curry Leaf Soda')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));

    expect(screen.getByText('Curry Leaf Soda')).toBeTruthy();
    // The half that proves narrowing actually happened.
    expect(screen.queryByText('Rice and Curry')).toBeNull();
    expect(screen.getByText(/in Beverage/)).toBeTruthy();
  });

  it('says which section came up empty, rather than implying the item does not exist', () => {
    const mixed = catalogueToMenuData([
      { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
      { ...item('p3', 'Lime Soda'), foodType: 'BEVERAGE' as const },
    ]);
    render(<PosMenuBrowser data={mixed} loading={false} onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));

    expect(
      screen.getByText('No items match "curry" in Beverage. Tap Beverage again to search every section.'),
    ).toBeTruthy();
  });

  it('does not let a search selection disturb where the operator was browsing', () => {
    const mixed = catalogueToMenuData([
      { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
      { ...item('p3', 'Lime Soda'), foodType: 'BEVERAGE' as const },
    ]);
    render(<PosMenuBrowser data={mixed} loading={false} onPick={vi.fn()} />);
    const input = screen.getByLabelText('Search the menu');

    // Browsing Food (the default first section).
    expect(screen.getByText('Rice and Curry')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'soda' } });
    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    // Back on Food, where they left off — not on Beverage, where the search
    // happened to land.
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.queryByText('Lime Soda')).toBeNull();
  });

  it('starts each new term from All', () => {
    const mixed = catalogueToMenuData([
      { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
      { ...item('p3', 'Lime Soda'), foodType: 'BEVERAGE' as const },
    ]);
    render(<PosMenuBrowser data={mixed} loading={false} onPick={vi.fn()} />);
    const input = screen.getByLabelText('Search the menu');

    fireEvent.change(input, { target: { value: 'soda' } });
    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));

    fireEvent.change(input, { target: { value: 'curry' } });

    // Carrying Beverage over would show an empty grid for a term that matches
    // a Food item — the operator would read that as "we don't sell it".
    expect(
      screen.getByRole('button', { name: 'Beverage' }).getAttribute('data-active'),
    ).toBeNull();
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
  });
});

describe('browsing stays one section at a time', () => {
  const MIXED = catalogueToMenuData([
    { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
    { ...item('p3', 'Lime Soda'), foodType: 'BEVERAGE' as const },
  ]);

  it('opens on the first section and shows only that section', () => {
    render(<PosMenuBrowser data={MIXED} loading={false} onPick={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Food' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.queryByText('Lime Soda')).toBeNull();
  });

  it('swaps sections rather than accumulating them', () => {
    render(<PosMenuBrowser data={MIXED} loading={false} onPick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));

    expect(screen.getByText('Lime Soda')).toBeTruthy();
    expect(screen.queryByText('Rice and Curry')).toBeNull();
  });

  it('does not release the section when the active chip is tapped again', () => {
    render(<PosMenuBrowser data={MIXED} loading={false} onPick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    // Releasing here would empty the grid with nothing to explain why. The
    // toggle exists only during a search, where "no section" means "all".
    expect(screen.getByRole('button', { name: 'Food' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByText('Rice and Curry')).toBeTruthy();
  });
});

describe('releasing a narrowed search', () => {
  const MIXED = catalogueToMenuData([
    { ...item('p1', 'Rice and Curry'), foodType: 'FOOD' as const },
    { ...item('p3', 'Curry Leaf Soda'), foodType: 'BEVERAGE' as const },
  ]);

  it('tapping the active chip again widens back to every section', () => {
    render(<PosMenuBrowser data={MIXED} loading={false} onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search the menu'), { target: { value: 'curry' } });

    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));
    expect(screen.queryByText('Rice and Curry')).toBeNull();

    // With no All chip this is the only route back short of retyping the term.
    fireEvent.click(screen.getByRole('button', { name: 'Beverage' }));

    expect(screen.getByText('Rice and Curry')).toBeTruthy();
    expect(screen.getByText('Curry Leaf Soda')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Beverage' }).getAttribute('data-active'),
    ).toBeNull();
  });
});
