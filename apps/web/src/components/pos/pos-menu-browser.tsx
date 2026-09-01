'use client';

import { Search, X } from 'lucide-react';
import * as React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView } from '@/lib/restaurant/types';

import type { MenuData } from './pos-types';

/**
 * Server-side search + paging, supplied by `usePosCatalogue`.
 *
 * Optional on purpose. The Takeaway workspace and any tenant still on the
 * legacy admin-menu chain render this component with `useMenuData`, which
 * loads the whole tree in one go and has nothing to page; omitting this prop
 * keeps that path on the original client-side filter, unchanged.
 */
export interface PosBrowserServerQuery {
  /** The live term, straight from the keyboard. Drives the input only. */
  search: string;
  onSearchChange: (value: string) => void;
  /**
   * The term the loaded rows actually reflect — `search` after debouncing.
   *
   * Kept separate so the grid does not flip into "results" mode during the
   * debounce window, when `data` is still the unfiltered page and would read
   * as "every item matched your search".
   */
  appliedSearch: string;
  /** The server has at least one more page for the current term. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Rows matching the term across every page. */
  total: number;
  /** Rows loaded so far. Not `filtered.length`, which narrows to one section. */
  loadedCount: number;
}

interface Props {
  data: MenuData;
  loading: boolean;
  onPick: (item: MenuItemView) => void;
  /**
   * When present, the term goes to the server and `data` already holds only
   * what matched. Absent = the original client-side substring filter.
   */
  serverQuery?: PosBrowserServerQuery;
}

/**
 * POS-runtime menu picker. Not the same component as the Menu-management
 * browser at /menu — that one is a config surface for the operator to
 * *edit* the catalogue. This one renders the same catalogue as a fast,
 * touch-friendly grid for building an order.
 *
 * Layout:
 *   - Search input at the top (name + description substring match).
 *   - A single row of section chips derived from the active menu(s). If
 *     more than one menu exists we prefix section labels with the menu
 *     name so a "Mains" collision between two menus stays distinguishable.
 *   - Responsive item grid — 2 cols on tablet, 3 on laptop, 4+ on desktop.
 *
 * Empty and loading states are handled here rather than by the caller so
 * every mode gets the same behaviour.
 */
export function PosMenuBrowser({ data, loading, onPick, serverQuery }: Props) {
  const [localSearch, setLocalSearch] = React.useState('');
  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);
  /*
   * Which section the operator has narrowed the RESULTS to, `null` for "All".
   *
   * Kept apart from `selectedSectionId` so a search never disturbs where the
   * operator was browsing: clearing the term puts them back on the section
   * they left, rather than wherever the last search happened to land.
   */
  const [searchSectionId, setSearchSectionId] = React.useState<string | null>(null);

  // One `search` for the rest of the component whichever mode is active, so
  // the chip/empty/result branches below stay single-path.
  const isServer = serverQuery != null;
  const search = isServer ? serverQuery.search : localSearch;
  const setSearch = isServer ? serverQuery.onSearchChange : setLocalSearch;
  /*
   * What `data` currently reflects. In client mode the filter is synchronous so
   * the typed term is always the applied one; in server mode it lags by the
   * debounce. Every branch that asks "are we showing search results?" reads
   * this, never `search`.
   */
  const activeTerm = isServer ? serverQuery.appliedSearch : search;

  // Flatten sections across menus into one linear list so a Takeaway
  // operator does not have to think about "which menu" first — most
  // pilot tenants ship exactly one active menu anyway.
  const allSections = React.useMemo(() => {
    const rows: { id: string; label: string }[] = [];
    for (const menu of data.menus) {
      const secs = data.sectionsByMenu.get(menu.id) ?? [];
      for (const s of secs) {
        rows.push({
          id: s.id,
          label: data.menus.length > 1 ? `${menu.name} · ${s.name}` : s.name,
        });
      }
    }
    return rows;
  }, [data]);

  // Default-select the first section once data lands.
  React.useEffect(() => {
    if (!selectedSectionId && allSections.length > 0) {
      const first = allSections[0];
      if (first) setSelectedSectionId(first.id);
    }
  }, [allSections, selectedSectionId]);

  // Every new term starts from "All". Carrying a section across would hide
  // matches the operator has not seen yet, and an empty grid would read as
  // "no such item" when the item is simply in another section.
  React.useEffect(() => {
    setSearchSectionId(null);
  }, [activeTerm]);

  const filtered = React.useMemo(() => {
    const q = activeTerm.trim().toLowerCase();
    /** Rows for one section, or every section for `All` / an unset selection. */
    const collect = (sectionId: string | null): MenuItemView[] => {
      if (sectionId) {
        return data.itemsBySection.get(sectionId) ?? [];
      }
      const rows: MenuItemView[] = [];
      for (const list of data.itemsBySection.values()) {
        for (const it of list) rows.push(it);
      }
      return rows;
    };

    if (!q) {
      // Nothing selected yet means the default-select effect below has not run;
      // showing every item for that one frame would flash the whole menu.
      if (!selectedSectionId) return [];
      return collect(selectedSectionId);
    }
    // Search widens beyond the current section by default, so a waiter typing
    // "kottu" doesn't need to guess which section it lives in. The chips stay
    // on screen to narrow that down afterwards.
    const acrossAll: MenuItemView[] = collect(searchSectionId);
    // In server mode `data` is already the match set, and the server matched
    // on fields this component cannot see — dietary tags and subcategory name.
    // Re-running the name/description filter here would silently DISCARD those
    // hits, so a search for a tag would come back empty despite the server
    // having found rows.
    if (isServer) return acrossAll;
    return acrossAll.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.description ?? '').toLowerCase().includes(q),
    );
  }, [activeTerm, selectedSectionId, searchSectionId, data, isServer]);

  const searching = activeTerm.trim() !== '';
  /*
   * Section chips only. While searching none is active to begin with, which is
   * what keeps results spanning every section the way search has always
   * behaved; while browsing the first section is selected as it always was.
   */
  const chips = allSections;
  const activeChipId = searching ? searchSectionId ?? '' : selectedSectionId ?? '';
  const narrowedLabel =
    searching && searchSectionId
      ? allSections.find((c) => c.id === searchSectionId)?.label ?? null
      : null;
  const selectChip = (id: string) => {
    // Browsing and searching keep separate selections — see `searchSectionId`.
    if (!searching) {
      // Browsing always sits in exactly one section; releasing it would leave
      // the grid empty with nothing to explain why.
      setSelectedSectionId(id);
      return;
    }
    // Tapping the active chip releases it, back to matches across every
    // section. Without an All chip this is the only route back, short of
    // retyping the term.
    setSearchSectionId((current) => (current === id ? null : id));
  };

  if (loading && data.menus.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading menu…
        </CardContent>
      </Card>
    );
  }

  // Guarded by the term: in server mode a search that matches nothing returns
  // zero items, which collapses `menus` to empty. Without this guard a typo
  // would claim the branch has no menu at all and tell the cashier to call an
  // administrator. An empty search still means what it always did.
  if (data.menus.length === 0 && activeTerm.trim() === '') {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          No active menu is configured for this branch. Ask an administrator to
          publish a menu before taking orders.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          /*
           * The placeholder names what the active mode actually matches. It
           * used to promise "station", which neither mode has ever searched:
           * server mode matches name, dietary tags and subcategory; client
           * mode matches name and description.
           */
          placeholder={
            isServer
              ? 'Search menu — items, tags, categories…'
              : 'Search menu — items, descriptions…'
          }
          // The placeholder is not an accessible name — it disappears as soon
          // as the cashier types, leaving the field unlabelled.
          aria-label="Search the menu"
          className="h-11 pl-9 pr-12"
        />
        {search !== '' ? (
          // Clearing by selecting the text and deleting is awkward on a till
          // tablet, and clearing is how the operator gets back to the section
          // grid after a lookup.
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors touch-target-coarse touch-manipulation hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {isServer && loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Searching…
        </p>
      ) : null}

      {/*
        The chip row stays on screen while searching. It used to be replaced by
        the result count, which cost the operator both ways: no route back to
        browsing without clearing the field, and no way to cut down a broad
        term — "curry" across four sections is a wall of cards.

        Section chips are a single scrollable row rather than wrap-to-many —
        on a portrait tablet with 8+ sections a wrap layout eats vertical
        space the menu grid needs. `<ChipRow>` supplies edge fades and
        chevron nudges so overflow reads as scroll, not clip. Each chip
        stays at least 44px tall on coarse pointers via `touch-target-coarse`.
      */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Section
        </span>
        <ChipRow activeKey={activeChipId} ariaLabel="Menu sections" className="min-w-0 flex-1">
          {chips.map((s) => (
            <button
              key={s.id}
              type="button"
              data-active={s.id === activeChipId ? 'true' : undefined}
              onClick={() => selectChip(s.id)}
              className={`inline-flex h-9 shrink-0 items-center rounded-full px-3 text-sm font-medium transition-colors touch-target-coarse touch-manipulation ${
                s.id === activeChipId
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-border'
              }`}
            >
              {s.label}
            </button>
          ))}
        </ChipRow>
      </div>

      {searching ? (
        serverQuery ? (
          // `total` is the server's count for the whole term, so it stays honest
          // when only the first page is loaded.
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {serverQuery.total} result
            {serverQuery.total === 1 ? '' : 's'} for &ldquo;{activeTerm}&rdquo;
            {narrowedLabel ? ` in ${narrowedLabel}` : ''}.
          </p>
        ) : narrowedLabel ? (
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} result{filtered.length === 1 ? '' : 's'} in {narrowedLabel}{' '}
            for &ldquo;{activeTerm}&rdquo;.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} result{filtered.length === 1 ? '' : 's'} across every
            section for &ldquo;{activeTerm}&rdquo;.
          </p>
        )
      ) : null}

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {activeTerm.trim() === ''
              ? 'This section has no items yet.'
              : narrowedLabel
                ? `No items match "${activeTerm}" in ${narrowedLabel}. Tap ${narrowedLabel} again to search every section.`
                : `No items match "${activeTerm}".`}
          </CardContent>
        </Card>
      ) : (
        // 3-across at `tab:` matches the tablet-responsive redesign: at
        // 900px the cart column reveals AND we have room for three cards
        // side by side. Below `tab:` we keep the two-column density so a
        // portrait iPad still shows six cards above the fold.
        <div className="grid grid-cols-2 gap-3 tab:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filtered.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onPick(it)}
              className="flex h-full flex-col rounded-xl border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary hover:shadow"
            >
              <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-2xl">
                {emojiFor(it.name)}
              </div>
              <span className="text-sm font-semibold leading-tight">{it.name}</span>
              {it.description ? (
                <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {it.description}
                </span>
              ) : null}
              <span className="mt-auto pt-2 text-sm font-semibold text-primary">
                {formatMoney(it.basePrice)}
              </span>
              {it.modifierGroupIds.length > 0 ? (
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Modifiers
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {/*
        Paging lives below the grid, not as an infinite scroller: a POS grid is
        tapped, and a list that grows under a moving finger mis-fires orders.
        The operator asks for more rows explicitly.
      */}
      {serverQuery?.hasMore ? (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={serverQuery.onLoadMore}
            disabled={serverQuery.loadingMore}
            className="inline-flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-5 text-sm font-medium transition-colors touch-target-coarse touch-manipulation hover:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {serverQuery.loadingMore
              ? 'Loading…'
              : `Load more (${serverQuery.loadedCount} of ${serverQuery.total})`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tiny naive emoji picker so item cards get a visual anchor without
 * requiring image uploads. Zero database dependency — the mapping is
 * intentionally shallow and safe (falls back to a plate). When the
 * MenuItem schema gains an `imageUrl` column this whole helper goes away.
 */
function emojiFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('coffee')) return '☕';
  if (n.includes('tea')) return '🫖';
  if (n.includes('soda') || n.includes('lime')) return '🍋';
  if (n.includes('juice')) return '🧃';
  if (n.includes('beer') || n.includes('cocktail')) return '🍸';
  if (n.includes('rice')) return '🍚';
  if (n.includes('kottu') || n.includes('curry')) return '🍛';
  if (n.includes('bread') || n.includes('toast')) return '🥪';
  if (n.includes('cheese')) return '🧀';
  if (n.includes('cashew') || n.includes('nut')) return '🥜';
  if (n.includes('ice cream') || n.includes('dessert')) return '🍨';
  if (n.includes('watalappan') || n.includes('cake')) return '🍮';
  if (n.includes('papadam') || n.includes('crisp')) return '🫓';
  return '🍽️';
}
