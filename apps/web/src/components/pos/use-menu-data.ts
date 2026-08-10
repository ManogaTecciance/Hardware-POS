'use client';

import * as React from 'react';

import type { Session } from '@/lib/auth';
import {
  menuItems as menuItemsApi,
  menuSections,
  menus,
  modifierGroups as modifierGroupsApi,
} from '@/lib/restaurant/api';
import type {
  MenuItemView,
  ModifierGroupView,
  SectionView,
} from '@/lib/restaurant/types';

import { EMPTY_MENU, type MenuData } from './pos-types';

/**
 * Loads the branch's active menu tree — every menu, every non-archived
 * section, every non-archived item, plus every modifier group — into the
 * shape the POS picker and the dine-in order-entry both render from.
 *
 * Filtering choices:
 *   - Only `isActive` menus / sections / items ship to the client. Archived
 *     rows must not be tappable from either surface, so the boundary sits
 *     here rather than in every consumer.
 *   - Sections are sorted by position, items by position. Callers should
 *     not re-sort — the deterministic order is the point.
 *
 * Independent fetch errors resolve to empty lists rather than throwing,
 * because a menu with, say, one broken section is still usable by the
 * operator; the alternative is a whole-page failure.
 */
export function useMenuData(
  session: Session,
  branchId: string | null,
): { data: MenuData; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = React.useState<MenuData>(EMPTY_MENU);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const menuRows = await menus.list(session, branchId, false).catch(() => []);
        const active = menuRows.filter((m) => m.isActive);
        const sectionLists = await Promise.all(
          active.map((m) => menuSections.list(session, m.id).catch(() => [])),
        );
        const sectionsByMenu = new Map<string, SectionView[]>();
        const items = new Map<string, MenuItemView[]>();
        const allSectionIds: string[] = [];
        active.forEach((m, i) => {
          const secs = (sectionLists[i] ?? [])
            .filter((s) => s.isActive)
            .sort((a, b) => a.position - b.position);
          sectionsByMenu.set(m.id, secs);
          for (const s of secs) allSectionIds.push(s.id);
        });
        const itemLists = await Promise.all(
          allSectionIds.map((sid) => menuItemsApi.list(session, sid, false).catch(() => [])),
        );
        allSectionIds.forEach((sid, i) => {
          const rows = (itemLists[i] ?? [])
            .filter((it) => it.isActive)
            .sort((a, b) => a.position - b.position);
          items.set(sid, rows);
        });
        const groupRows = await modifierGroupsApi
          .list(session, false)
          .catch(() => [] as ModifierGroupView[]);
        const modifierGroupsById = new Map<string, ModifierGroupView>();
        for (const g of groupRows) modifierGroupsById.set(g.id, g);
        if (cancelled) return;
        setData({ menus: active, sectionsByMenu, itemsBySection: items, modifierGroupsById });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load menu');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, branchId, tick]);

  const reload = React.useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
