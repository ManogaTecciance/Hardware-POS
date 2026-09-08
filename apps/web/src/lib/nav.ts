/**
 * Module-aware navigation (Slice 8.3; D56 re-sourced it from the domain
 * registry).
 *
 * The nav LISTS live in `@hardware-pos/shared` now, declared per domain
 * descriptor with icons referenced by name — see `domains/navigation.ts` for
 * why. This file binds those names to `lucide-react` components and keeps the
 * resolution pipeline: three filters (business type → module → permission),
 * behaviourally unchanged and pinned by `nav.test.ts`.
 */
import {
  BarChart3,
  CalendarDays,
  ChefHat,
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
import {
  domainFor,
  type BusinessType,
  type NavGroupSpec,
  type NavIconName,
} from '@hardware-pos/shared';

import { Permission } from './permissions';
import type { ModuleKey } from './platform-api';

/**
 * The ONE place icon names bind to components (D56). `Record<NavIconName, …>`
 * is total both ways: a descriptor naming an icon missing here fails the
 * build, and `nav-icon-totality` in the render tests asserts nothing here is
 * dead weight.
 */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  BarChart3,
  CalendarDays,
  ChefHat,
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
};

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the user holds this permission; an array means any-of (D93). */
  permission?: Permission | readonly Permission[];
  /** Shown only when the tenant has this module enabled. Omitted = shared core. */
  module?: ModuleKey;
  /** The route exists but the feature behind it is not built yet. */
  upcoming?: boolean;
}

export interface NavGroup {
  /** Section heading; `null` for the ungrouped lead item(s). */
  label: string | null;
  items: NavItem[];
}

/**
 * D93 — the permission half of the nav gate, as ANY-of.
 *
 * Written as an explicit `for` rather than `[].some(input.hasPermission)`:
 * `some` hands its callback (value, index, array), and `hasPermission` taking a
 * second argument it ignores today is not a thing to rely on.
 *
 * The `length === 0` case is a REFUSAL, not a pass. An entry whose gate is an
 * empty array is a mistake — someone deleted the last permission from a list —
 * and the fail-open reading would put that destination in front of every role
 * in the product. `undefined` still means ungated, which is how shared-core
 * destinations are declared.
 *
 * Exported ONLY so that empty-array branch can be tested. No nav spec carries
 * an empty gate today, so it is unreachable through `resolveNavigation`, and a
 * tripwire that can only assert against a hand-written stand-in is not a
 * tripwire (D30) — the first draft of this one fell open undetected.
 */
export function holdsAnyOf(
  permission: Permission | readonly Permission[] | undefined,
  input: { hasPermission: (permission: Permission) => boolean },
): boolean {
  if (permission === undefined) return true;
  if (!Array.isArray(permission)) return input.hasPermission(permission as Permission);
  for (const candidate of permission as readonly Permission[]) {
    if (input.hasPermission(candidate)) return true;
  }
  return false;
}

/** Bind one shared spec group to renderable items. */
function bindGroups(groups: readonly NavGroupSpec[]): NavGroup[] {
  return groups.map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      href: item.href,
      label: item.label,
      icon: NAV_ICONS[item.icon],
      permission: item.permission as Permission | readonly Permission[] | undefined,
      module: item.module as ModuleKey | undefined,
      upcoming: item.upcoming,
    })),
  }));
}

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
 *  1. **Business type** picks the base list — from the domain registry, with
 *     **no fallback** (D56). The `?? RETAIL_NAV` this replaced is the exact
 *     mechanism that would hand a mis-wired domain the retail rail; an
 *     unknown value now renders the same empty rail as an unresolved profile,
 *     which is visibly wrong instead of plausibly wrong.
 *  2. **Tenant module** — the feature is switched on for this tenant.
 *  3. **User permission** — this user may use it.
 *
 * ## While the profile is unresolved
 *
 * Returns an **empty** list rather than a guess. Rendering the retail
 * navigation and then swapping it is the flash this design exists to prevent;
 * the shell renders a neutral placeholder instead.
 *
 * ## This is not access control
 *
 * Hiding a link is a usability affordance. Every route is enforced
 * server-side by `PermissionsGuard` and `ModuleAccessGuard`; typing the URL
 * of a hidden page gets a 403 from the API regardless of what the sidebar
 * drew.
 */
export function resolveNavigation(input: NavigationInput): NavGroup[] {
  if (input.businessType === null || input.enabledModules === null) return [];

  const domain = (
    input.businessType in NAV_CACHE ? NAV_CACHE[input.businessType as BusinessType] : null
  );
  if (!domain) return [];
  const enabled = new Set(input.enabledModules);

  return domain
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.module || enabled.has(item.module)) && holdsAnyOf(item.permission, input),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Bound-and-cached navigation per business type. Bound once per UNIQUE spec
 * list (several business types share one — all food service shares the
 * restaurant list), keyed by the spec array's identity, so shared lists stay
 * one object and `ALL_NAV_ITEMS` below counts each destination once.
 */
const BOUND = new Map<readonly NavGroupSpec[], NavGroup[]>();
function boundGroups(groups: readonly NavGroupSpec[]): NavGroup[] {
  let bound = BOUND.get(groups);
  if (!bound) {
    bound = bindGroups(groups);
    BOUND.set(groups, bound);
  }
  return bound;
}

const NAV_CACHE: Record<BusinessType, NavGroup[]> = {
  HARDWARE: boundGroups(domainFor('HARDWARE').navigation),
  RESTAURANT: boundGroups(domainFor('RESTAURANT').navigation),
  CAFE: boundGroups(domainFor('CAFE').navigation),
  BAKERY: boundGroups(domainFor('BAKERY').navigation),
  HOTEL: boundGroups(domainFor('HOTEL').navigation),
  GENERAL: boundGroups(domainFor('GENERAL').navigation),
};

/**
 * Every destination any workspace can reach, for the route-coverage test —
 * one entry per (list, item), not per business type, because several types
 * share one list. A navigation entry that 404s looks like a broken app
 * rather than an unbuilt feature.
 */
export const ALL_NAV_ITEMS: NavItem[] = [...BOUND.values()].flatMap((groups) =>
  groups.flatMap((g) => g.items),
);

/**
 * Route prefix → required module, **derived from the navigation lists**
 * (Slice 8.6). A route table written by hand drifts from the sidebar the
 * first time a module key changes in one place and not the other.
 *
 * An href claimed by more than one workspace only counts as gated when
 * **every** declaration agrees on the same module. A future entry that gated
 * a shared route in one workspace and not the other must resolve to the
 * server's answer (ungated), never to the stricter guess, or a tenant loses a
 * page the API would have served.
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
 * Like `resolveNavigation`, this is **usability, not access control**.
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
