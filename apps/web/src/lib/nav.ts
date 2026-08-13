import {
  BarChart3,
  CalendarDays,
  ChefHat,
  // ClipboardList — reserved for the /menu icon; kept commented alongside the
  // commented-out nav entry below so a re-enable is a one-line change.
  // ClipboardList,
  FileText,
  LayoutDashboard,
  Link2,
  ListChecks,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Truck,
  Undo2,
  UtensilsCrossed,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { Permission } from './permissions';
import type { ModuleKey } from './platform-api';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the user holds this permission. */
  permission?: Permission;
  /**
   * Shown only when the tenant has this module enabled.
   *
   * Omitted for shared-core destinations that every business profile needs
   * (dashboard, products, settings). Those are still permission-gated.
   */
  module?: ModuleKey;
  /**
   * The route exists but the feature behind it is not built yet.
   *
   * Rendered with a visible "Soon" marker. The alternative — hiding it — would
   * make the Restaurant workspace look complete when it is a shell, which is the
   * one thing Phase 1 must not imply.
   */
  upcoming?: boolean;
}

export interface NavGroup {
  /** Section heading; `null` for the ungrouped lead item(s). */
  label: string | null;
  items: NavItem[];
}

/**
 * Navigation for a retail workspace (Tile Shop, Hardware, Retail).
 *
 * **This is the pre-Slice-8 list, unchanged**, with `module` keys added. A legacy
 * tenant has every one of those modules enabled by default, so the rendered result
 * is identical to what shipped before — asserted by `nav.test.ts`.
 */
const RETAIL_NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Operations',
    items: [
      {
        href: '/pos',
        label: 'POS',
        icon: ShoppingCart,
        permission: Permission.SALE_CREATE,
        module: 'RETAIL_POS',
      },
      // No module key: completed-sale history is shared core, classified by the
      // product owner after Slice 8. Every business profile needs to look up what
      // it has already sold, and the API gates the sales controller on no module
      // either. `RETAIL_POS` governs *taking* a sale, which is a retail workflow;
      // restaurant ordering is a separate future module, not this route.
      { href: '/sales', label: 'Sales', icon: ReceiptText, permission: Permission.SALE_READ },
      {
        href: '/quotations',
        label: 'Quotations',
        icon: FileText,
        permission: Permission.QUOTATION_READ,
        module: 'QUOTATIONS',
      },
      {
        href: '/returns',
        label: 'Returns',
        icon: Undo2,
        permission: Permission.RETURN_READ,
        module: 'RETURNS',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      // No module key: the product catalogue is shared core. `INVENTORY` means
      // stock tracking, which is governed by InventoryMode (D28/D31/D35) — gating
      // the catalogue on it would hide products from a tenant that owns them.
      { href: '/products', label: 'Products', icon: Package, permission: Permission.PRODUCT_READ },
      {
        href: '/suppliers',
        label: 'Suppliers',
        icon: Truck,
        permission: Permission.SUPPLIER_READ,
        module: 'SUPPLIERS',
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: Users,
        permission: Permission.CUSTOMER_READ,
        module: 'CUSTOMERS',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        href: '/quickbooks',
        label: 'QuickBooks',
        icon: Link2,
        permission: Permission.QUICKBOOKS_READ,
        module: 'QUICKBOOKS',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        permission: Permission.SETTINGS_MANAGE,
        module: 'SETTINGS',
      },
    ],
  },
];

/**
 * Navigation for a food-service workspace.
 *
 * Every operational entry is `upcoming`: the routes are shells and the workflows
 * behind them begin in Restaurant Phase 2. They are shown rather than hidden so the
 * shape of the product is visible, and marked so nothing claims to work.
 *
 * Deliberately absent: POS, Quotations, Returns, Suppliers and QuickBooks. Those are
 * retail concerns (decision D2), and a restaurant profile does not enable their
 * modules — so even without this list they would be filtered out. Both mechanisms
 * agree, and `nav.test.ts` asserts it from both directions.
 */
const RESTAURANT_NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Service',
    items: [
      {
        // Pilot Change 2 Slice B — unified POS workspace with mode selector
        // (Dine In / Takeaway / 3rd Party). Takeaway is no longer a top-level
        // destination — it lives as `POS → Takeaway` per PO decision 3.
        href: '/pos',
        label: 'POS',
        icon: ShoppingCart,
        permission: Permission.SALE_CREATE,
        module: 'TABLE_MANAGEMENT',
      },
      {
        // Pilot Change 2 Slice D — unified Orders queue across every channel.
        href: '/orders',
        label: 'Orders',
        icon: ListChecks,
        permission: Permission.TABLE_VIEW,
        module: 'TABLE_MANAGEMENT',
      },
      {
        // Frontend Phase F — kitchen ticket board + reprint actions are live.
        href: '/kitchen',
        label: 'Kitchen',
        icon: ChefHat,
        permission: Permission.KOT_VIEW,
        module: 'KITCHEN',
      },
      {
        // Frontend Phase C — tables floor + area/table management is live.
        href: '/tables',
        label: 'Tables',
        icon: UtensilsCrossed,
        permission: Permission.SALE_CREATE,
        module: 'TABLE_MANAGEMENT',
      },
      {
        // D47 — the reservation book: day grid of tables × timeslots.
        href: '/calendar',
        label: 'Calendar',
        icon: CalendarDays,
        permission: Permission.RESERVATION_VIEW,
        module: 'RESERVATIONS',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      // D45: `/menu` is intentionally removed from the Restaurant rail. The
      // Product Wizard (Restaurant) is now the single authoring surface for
      // sellable items — a Restaurant owner adds dishes and packaged goods
      // in the same place under Products, and the runtime POS reads them
      // from `GET /restaurant/pos-catalogue`. The `/menu/**` route files are
      // kept so support staff can still reach the legacy MenuBrowser via a
      // typed URL (`/menu?view=legacy`), but the nav entry is gone.
      //
      // If a future business type wants a distinct authoring surface, put
      // it back here — do not re-enable this line without a decision record.
      // {
      //   href: '/menu',
      //   label: 'Menu',
      //   icon: ClipboardList,
      //   permission: Permission.PRODUCT_READ,
      //   module: 'MENU_MANAGEMENT',
      // },
      // Restaurant tenants label the shared product catalogue "Inventory"
      // so it reads clearly as the authoring surface for every sellable
      // item. Retail tenants keep the label "Products" (see RETAIL_NAV above).
      {
        href: '/products',
        label: 'Inventory',
        icon: Package,
        permission: Permission.PRODUCT_READ,
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: Users,
        permission: Permission.CUSTOMER_READ,
        module: 'CUSTOMERS',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        href: '/sales',
        label: 'Sales',
        icon: ReceiptText,
        permission: Permission.SALE_READ,
      },
      {
        // Frontend Phase I — restaurant reports dashboard.
        href: '/reports',
        label: 'Reports',
        icon: BarChart3,
        permission: Permission.REPORT_READ,
        module: 'REPORTING',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        permission: Permission.SETTINGS_MANAGE,
        module: 'SETTINGS',
      },
    ],
  },
];

/** Which base list a business type starts from. */
const NAV_BY_BUSINESS_TYPE: Record<string, NavGroup[]> = {
  TILE_SHOP: RETAIL_NAV,
  HARDWARE: RETAIL_NAV,
  RETAIL: RETAIL_NAV,
  RESTAURANT: RESTAURANT_NAV,
  CAFE: RESTAURANT_NAV,
  BAKERY: RESTAURANT_NAV,
  // D55: the hotel template renders the restaurant navigation for now. When
  // hotels need their own, this line is the change — not a data migration.
  HOTEL: RESTAURANT_NAV,
  GENERAL: RETAIL_NAV,
};

export interface NavigationInput {
  /** From the effective profile. `null` while the profile is unresolved. */
  businessType: string | null;
  /** From the effective profile. `null` while unresolved. */
  enabledModules: readonly ModuleKey[] | null;
  hasPermission: (permission: Permission) => boolean;
}

/**
 * The navigation a user should see.
 *
 * Three filters, all of which must pass:
 *
 *  1. **Business type** picks the base list.
 *  2. **Tenant module** — the feature is switched on for this tenant.
 *  3. **User permission** — this user may use it.
 *
 * ## While the profile is unresolved
 *
 * Returns an **empty** list rather than a guess. Rendering the retail navigation
 * and then swapping it is the flash this design exists to prevent: a restaurant
 * operator would see POS, Quotations and QuickBooks appear and vanish on every page
 * load, and would keep seeing them forever if the profile request ever failed.
 * The shell renders a neutral placeholder instead.
 *
 * ## This is not access control
 *
 * Hiding a link is a usability affordance. Every route is enforced server-side by
 * `PermissionsGuard` and `ModuleAccessGuard`; typing the URL of a hidden page gets
 * a 403 from the API regardless of what the sidebar drew.
 */
export function resolveNavigation(input: NavigationInput): NavGroup[] {
  if (input.businessType === null || input.enabledModules === null) return [];

  const base = NAV_BY_BUSINESS_TYPE[input.businessType] ?? RETAIL_NAV;
  const enabled = new Set(input.enabledModules);

  return base
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.module || enabled.has(item.module)) &&
          (!item.permission || input.hasPermission(item.permission)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Every destination any workspace can reach, for the route-coverage test.
 *
 * Exported so a spec can assert that each `href` corresponds to a real page — the
 * failure mode being a navigation entry that 404s, which looks like a broken app
 * rather than an unbuilt feature.
 */
export const ALL_NAV_ITEMS: NavItem[] = [...RETAIL_NAV, ...RESTAURANT_NAV].flatMap((g) => g.items);

/**
 * Route prefix → required module, **derived from the navigation lists above**
 * (Slice 8.6).
 *
 * Deriving it rather than maintaining a second table is the whole point: a route
 * table written by hand drifts from the sidebar the first time a module key is
 * changed in one place and not the other, and the symptom — a link that opens a
 * page the tenant should not have — is exactly what this mechanism exists to
 * prevent.
 *
 * An href claimed by both workspaces only counts as gated when **every**
 * declaration agrees on the same module. Nothing disagrees today — `/sales` was
 * the one case, and the product owner has since classified it as shared core in
 * both lists — but the rule stays: a future entry that gated a shared route in one
 * workspace and not the other must resolve to the server's answer (ungated), never
 * to the stricter guess, or a tenant loses a page the API would have served.
 */
const ROUTE_MODULES: ReadonlyMap<string, ModuleKey> = (() => {
  const declared = new Map<string, ModuleKey | null>();
  for (const item of ALL_NAV_ITEMS) {
    // Not named `module`: Next's linter reserves that identifier.
    const moduleKey = item.module ?? null;
    if (!declared.has(item.href)) declared.set(item.href, moduleKey);
    else if (declared.get(item.href) !== moduleKey) declared.set(item.href, null);
  }

  const gated = new Map<string, ModuleKey>();
  for (const [href, moduleKey] of declared) if (moduleKey) gated.set(href, moduleKey);
  return gated;
})();

/**
 * The module a path requires, or `null` when the path is ungated.
 *
 * Matches on whole segments so `/products` gates `/products/abc` but never
 * `/products-report`, and the longest match wins so `/quickbooks/settings` is
 * governed by `/quickbooks` rather than by a shorter prefix.
 *
 * Like `resolveNavigation`, this is **usability, not access control**. The server's
 * `ModuleAccessGuard` refuses the underlying requests regardless; this only stops a
 * bookmarked or hand-typed URL from rendering a screen full of failing calls.
 */
export function moduleForPath(pathname: string): ModuleKey | null {
  let bestHref = '';
  let bestModule: ModuleKey | null = null;

  for (const [href, moduleKey] of ROUTE_MODULES) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);
    if (matches && href.length > bestHref.length) {
      bestHref = href;
      bestModule = moduleKey;
    }
  }

  return bestModule;
}
