'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { useEffectiveProfile } from '@/lib/platform-profile';
import {
  resolveCatalogueTabs,
  type CatalogueTabPresentation,
} from '@/lib/products/product-presentation';
import { cn } from '@/lib/utils';

/**
 * Inventory tab bar (D45).
 *
 * Sits at the top of `/products`, `/products/categories`,
 * `/products/promotions`, `/products/attributes` and `/products/barcodes` so
 * the surfaces read as one Inventory area rather than several unrelated
 * screens.
 *
 * The two Phase 5 tabs are here rather than in the main rail because
 * `nav.test.ts` asserts the retail rail as an EXACT sequence, mutation-proven,
 * and D16 forbids editing an existing behavioural assertion to accommodate new
 * work. They are also catalogue sub-surfaces, which is what this bar is for.
 *
 * D139 — and those two are not for every workspace. Attributes (the reusable
 * variation library) is retail's; Barcodes (in-store EAN-13 allocation) is for
 * anyone who stocks and labels physical goods, so hardware keeps it and a
 * kitchen does not. The bar does NOT decide that: it reads flags from
 * `resolveCatalogueTabs`, because a component that compares a business type is
 * exactly what D56 and the products resolver exist to prevent.
 *
 * Hiding is usability. Both routes still answer to anyone who types the URL
 * and holds the permission; D125 made `/attribute-library` shared core on
 * purpose, and nothing here changes an authority.
 *
 * Each tab is a plain `<Link>` — routing lives with Next, not with local state
 * — so a mid-list refresh, back button or shareable URL all behave correctly.
 *
 * "Stock" and "Purchases" are surfaced as placeholder tabs with a matching
 * disabled state, per the D45 note. Placing them here rather than hiding them
 * gives operators the mental map of the eventual inventory area without
 * shipping a broken route.
 */

interface Tab {
  href: string;
  label: string;
  /** Fully route-matching alternative paths (e.g. `/products/:id`). */
  matchPrefixes?: string[];
  disabled?: boolean;
  /**
   * D139 — the flag that decides whether this workspace is offered the tab.
   *
   * A KEY into the resolved presentation, not a boolean baked into the array:
   * the array is module-level and the answer is per-tenant, so a boolean here
   * would be resolved once at import and shared by every workspace the tab
   * ever renders for. Absent means "everyone", which is the four tabs that
   * are not gated.
   */
  requires?: keyof CatalogueTabPresentation;
}

const TABS: Tab[] = [
  { href: '/products', label: 'Products', matchPrefixes: ['/products/new'] },
  { href: '/products/categories', label: 'Categories' },
  { href: '/products/promotions', label: 'Promotions' },
  // Phase 5 — D125 / D125a. Gated per workspace since D139.
  { href: '/products/attributes', label: 'Attributes', requires: 'showAttributes' },
  { href: '/products/barcodes', label: 'Barcodes', requires: 'showBarcodes' },
  // Stock + Purchases are placeholder tabs — the wording sets expectations,
  // the disabled state prevents an operator following a dead route. When the
  // dedicated pages ship, flip `disabled` off and add real `href`s.
  { href: '/products', label: 'Stock', disabled: true },
  { href: '/products', label: 'Purchases', disabled: true },
];

function isActive(pathname: string, tab: Tab): boolean {
  if (tab.disabled) return false;
  if (tab.href === '/products') {
    // Exact match — nested product routes (edit, new, promotions, categories)
    // must NOT light up the Products tab except when the path is the list or
    // an explicit match prefix.
    return (
      pathname === '/products' ||
      (tab.matchPrefixes?.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? false)
    );
  }
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

export function InventoryTabs({ className }: { className?: string }) {
  const pathname = usePathname() ?? '';
  /*
   * Read here rather than threaded from each of the five pages that render
   * this bar: five props is five chances to pass the wrong one, and the bar
   * is the only thing that needs the answer. `product-wizard.tsx` reads the
   * profile the same way for `resolveMeasuredGoods`.
   */
  const { profile } = useEffectiveProfile();
  const view = resolveCatalogueTabs(profile?.businessType ?? null);
  const tabs = TABS.filter((tab) => tab.requires === undefined || view[tab.requires]);

  return (
    <div
      role="tablist"
      aria-label="Inventory sections"
      className={cn('flex flex-wrap items-center gap-1 border-b border-border', className)}
    >
      {tabs.map((tab) => {
        const active = isActive(pathname, tab);
        if (tab.disabled) {
          return (
            <span
              key={tab.label}
              role="tab"
              aria-disabled="true"
              aria-selected={false}
              className="inline-flex h-10 items-center px-4 text-sm font-medium text-muted-foreground/60"
              title="Coming soon"
            >
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.label}
            href={tab.href}
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-10 items-center px-4 text-sm font-medium transition-colors rounded-t-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              active
                ? 'text-primary border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
