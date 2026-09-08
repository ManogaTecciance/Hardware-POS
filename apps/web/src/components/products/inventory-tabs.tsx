'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Inventory tab bar (D45).
 *
 * Sits at the top of `/products`, `/products/categories` and
 * `/products/promotions` so the four surfaces read as one Inventory area
 * rather than three unrelated screens. Each tab is a plain `<Link>` — routing
 * lives with Next, not with local state — so a mid-list refresh, back button
 * or shareable URL all behave correctly.
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
}

const TABS: Tab[] = [
  { href: '/products', label: 'Products', matchPrefixes: ['/products/new'] },
  { href: '/products/categories', label: 'Categories' },
  { href: '/products/promotions', label: 'Promotions' },
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

  return (
    <div
      role="tablist"
      aria-label="Inventory sections"
      className={cn('flex flex-wrap items-center gap-1 border-b border-border', className)}
    >
      {TABS.map((tab) => {
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
