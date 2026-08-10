'use client';

import { Search } from 'lucide-react';
import * as React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/restaurant/labels';
import type { MenuItemView } from '@/lib/restaurant/types';

import type { MenuData } from './pos-types';

interface Props {
  data: MenuData;
  loading: boolean;
  onPick: (item: MenuItemView) => void;
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
export function PosMenuBrowser({ data, loading, onPick }: Props) {
  const [search, setSearch] = React.useState('');
  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);

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

  const currentItems: MenuItemView[] = selectedSectionId
    ? data.itemsBySection.get(selectedSectionId) ?? []
    : [];

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return currentItems;
    // Search widens beyond the current section so a waiter typing "kottu"
    // doesn't need to guess which section it lives in.
    const acrossAll: MenuItemView[] = [];
    for (const list of data.itemsBySection.values()) {
      for (const it of list) acrossAll.push(it);
    }
    return acrossAll.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.description ?? '').toLowerCase().includes(q),
    );
  }, [search, currentItems, data]);

  if (loading && data.menus.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading menu…
        </CardContent>
      </Card>
    );
  }

  if (data.menus.length === 0) {
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
          placeholder="Search menu — items, tags, station…"
          className="h-11 pl-9"
        />
      </div>

      {search.trim() === '' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Section
          </span>
          {allSections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedSectionId(s.id)}
              className={`inline-flex h-9 items-center rounded-full px-3 text-sm font-medium transition-colors ${
                s.id === selectedSectionId
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-border'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Showing {filtered.length} result{filtered.length === 1 ? '' : 's'} across every
          section for &ldquo;{search}&rdquo;.
        </p>
      )}

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {search.trim() === ''
              ? 'This section has no items yet.'
              : `No items match "${search}".`}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
