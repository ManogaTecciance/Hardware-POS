'use client';

import * as React from 'react';

import type { Session } from '@/lib/auth';
import {
  menuItems as menuItemsApi,
  menuSections,
  menus,
  modifierGroups as modifierGroupsApi,
} from '@/lib/restaurant/api';
import {
  fetchPosCatalogue,
  type PosCatalogueChannel,
  type PosCatalogueItem,
} from '@/lib/restaurant/pos-catalogue-api';
import type {
  MenuItemView,
  MenuView,
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

// ─────────────────────────────────────────────────────────────────────────────
// POS Catalogue hook (D45)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The synthetic Menu id every catalogue-derived section belongs to.
 *
 * Callers keying off `MenuData.menus[i].id` see a stable identifier and can
 * treat the catalogue as a single-menu branch — a real MenuItem id starts
 * with `mit_…`, so there is no collision.
 */
const CATALOGUE_MENU_ID = '__catalogue__';

/**
 * One synthetic section per foodType bucket. The picker's chip row reads
 * `SectionView.name` for the label, so these are the strings the operator
 * sees at the top of the grid.
 */
const FOOD_TYPE_SECTIONS: Array<{ id: string; name: string; foodType: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null; position: number }> = [
  { id: '__section_food__', name: 'Food', foodType: 'FOOD', position: 1 },
  { id: '__section_beverage__', name: 'Beverage', foodType: 'BEVERAGE', position: 2 },
  { id: '__section_dessert__', name: 'Dessert', foodType: 'DESSERT', position: 3 },
  // Catch-all for Products the wizard did not tag with a foodType — most
  // legacy Retail rows a Restaurant tenant reactivates land here.
  { id: '__section_other__', name: 'Other', foodType: null, position: 4 },
];

/**
 * Load the branch's POS-sellable catalogue (D45) and shape it into the
 * same `MenuData` structure the picker + modifier dialog consume.
 *
 * Why a shape adapter rather than a second picker component:
 *   - `pos-menu-browser.tsx` is 200 LOC of chip + grid + search + empty
 *     states that reads MenuData and does not care where the rows came
 *     from. Duplicating it for the catalogue would double the surface a
 *     future POS tweak has to touch.
 *   - The modifier dialog also takes a `groupsById: Map<string, ModifierGroupView>`.
 *     The catalogue's modifier shape is a superset (same fields plus
 *     `role`), so a one-to-one map keeps everything working.
 *
 * Trade-offs the adapter accepts:
 *   - **`sectionId` is synthetic.** Each item is placed in one of four
 *     foodType buckets; a real MenuItem id starts `mit_…` so the invented
 *     ids can never collide.
 *   - **Variants collapse to the default price.** The picker still displays
 *     one card per Product. Variant selection at the POS is a separate
 *     concern (Phase 3) — for now the default variant's price shows and
 *     the item enters the cart at that price.
 *   - **`prepMinutes`, `dietaryTags`, `imageUrl`, `itemType`** are all
 *     carried through so future card enhancements can read them without
 *     another round-trip.
 */
export function usePosCatalogue(
  session: Session,
  branchId: string | null,
  channel?: PosCatalogueChannel,
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
        const res = await fetchPosCatalogue(session, { branchId, channel });
        if (cancelled) return;
        setData(catalogueToMenuData(res.items));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load catalogue');
        setData(EMPTY_MENU);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, branchId, channel, tick]);

  const reload = React.useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

/**
 * Pure adapter — exported for tests. Keep this function synchronous and
 * side-effect free so a snapshot test can pin the shape without spinning
 * up a fetch mock.
 */
export function catalogueToMenuData(items: PosCatalogueItem[]): MenuData {
  const now = new Date().toISOString();
  const menu: MenuView = {
    id: CATALOGUE_MENU_ID,
    branchId: '',
    name: 'Menu',
    description: null,
    isActive: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const itemsBySection = new Map<string, MenuItemView[]>();
  const modifierGroupsById = new Map<string, ModifierGroupView>();
  const activeSections: SectionView[] = [];

  for (const section of FOOD_TYPE_SECTIONS) {
    const bucket = items.filter((it) => it.foodType === section.foodType);
    if (bucket.length === 0) continue;
    activeSections.push({
      id: section.id,
      menuId: CATALOGUE_MENU_ID,
      name: section.name,
      description: null,
      position: section.position,
      isActive: true,
    });
    itemsBySection.set(
      section.id,
      bucket.map((it, i) => toMenuItemView(it, section.id, i, modifierGroupsById, now)),
    );
  }

  const sectionsByMenu = new Map<string, SectionView[]>();
  if (activeSections.length > 0) {
    sectionsByMenu.set(CATALOGUE_MENU_ID, activeSections);
  }

  return {
    // If the catalogue returned zero items we still expose an empty menu
    // list rather than a placeholder — the picker's own empty state ("No
    // active menu is configured") reads better than a menu with no
    // sections.
    menus: activeSections.length > 0 ? [menu] : [],
    sectionsByMenu,
    itemsBySection,
    modifierGroupsById,
  };
}

function toMenuItemView(
  item: PosCatalogueItem,
  sectionId: string,
  position: number,
  modifierGroupsById: Map<string, ModifierGroupView>,
  timestamp: string,
): MenuItemView {
  // D46 — only active variants are exposed to the picker; inactive rows
  // survive the wizard for admin visibility but must never be tappable at
  // the POS. The dialog itself still receives inactives (via `item.variants`)
  // when it wants to render an "Unavailable" affordance; for now the runtime
  // picker only cares about active ones.
  const activeVariants = item.variants.filter((v) => v.isActive);
  // Default variant preference — a wizard-marked default wins; else the
  // cheapest active variant so the card price is the honest floor an
  // operator can advertise.
  const defaultVariant =
    activeVariants.find((v) => v.isDefault) ??
    [...activeVariants].sort((a, b) => a.unitPrice - b.unitPrice)[0];
  // Base price: for a Product WITH variants the card shows the default
  // (or cheapest active) variant's price, so the fast-add tap matches the
  // dialog's preselected radio. Without variants the Product's own unitPrice
  // is authoritative; `null` on both is a real config error but the card
  // still surfaces at "0" — a cashier can add a discount to zero-price
  // sticker items rather than have the row silently disappear.
  const basePriceNumber =
    activeVariants.length > 0
      ? defaultVariant?.unitPrice ?? 0
      : item.unitPrice ?? 0;

  // Register every group the item references. Groups are dedup'd by id, so
  // two items sharing "Spice level" collapse to one entry the modifier
  // dialog can look up.
  for (const g of item.modifierGroups) {
    if (modifierGroupsById.has(g.id)) continue;
    modifierGroupsById.set(g.id, {
      id: g.id,
      name: g.name,
      selection: g.selection,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      isActive: true,
      role: g.role,
      options: g.options.map((o, idx) => ({
        id: o.id,
        name: o.name,
        priceDelta: String(o.priceDelta),
        position: idx,
        isActive: o.isActive,
      })),
    });
  }

  return {
    id: item.id,
    sectionId,
    name: item.name,
    description: item.description,
    basePrice: String(basePriceNumber),
    // Products come from `/products`, so this is really a productId — no
    // MenuItem row exists behind it. Left non-null so downstream code that
    // shows a "linked to Product" affordance still fires; `catalogueSource`
    // below is the authoritative discriminator for cart writes (D46).
    productId: item.id,
    isActive: true,
    position,
    modifierGroupIds: item.modifierGroups.map((g) => g.id),
    stationIds: item.stations.map((s) => s.id),
    channelPrices: [],
    availability: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    itemType: item.foodType,
    prepMinutes: item.prepMinutes,
    dietaryTags: item.dietaryTags,
    imageUrl: item.imageUrl,
    // D46 — cart writes route on this: `'PRODUCT'` sends `{sourceKind:
    // 'PRODUCT', productId, productVariantId?}`, absent/`'MENU_ITEM'` keeps
    // the legacy `{menuItemId}` shape. `productId` alone is not a safe
    // discriminator — legacy MenuItems may link a Product for inventory.
    catalogueSource: 'PRODUCT',
    // Only actives surface to the runtime picker; the Customise dialog
    // treats the whole list as authoritative and does not re-filter.
    variants: activeVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      unitPrice: v.unitPrice,
      isDefault: v.isDefault,
      isActive: v.isActive,
    })),
  };
}
