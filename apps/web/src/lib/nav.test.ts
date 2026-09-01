/**
 * Module-aware navigation (Slice 8.3).
 *
 * The load-bearing claim is a *negative* one — a Restaurant tenant must not see
 * POS, Quotations, Returns, Suppliers or QuickBooks — and negatives are where
 * navigation tests go vacuous: a resolver that returned nothing at all would
 * satisfy every one of them. So each mode is also asserted positively for what it
 * *does* show, and the retail and restaurant results are compared against each
 * other so they cannot quietly converge.
 */
import { describe, expect, it } from 'vitest';

import {
  FOOD_SERVICE_NAVIGATION,
  RESTAURANT_ROLE_TEMPLATES,
  RETAIL_NAVIGATION,
} from '@hardware-pos/shared';

import { ALL_NAV_ITEMS, holdsAnyOf, moduleForPath, resolveNavigation, type NavGroup } from './nav';
import { Permission, ROLE_PERMISSIONS, type UserRole } from './permissions';
import type { ModuleKey } from './platform-api';

/** Mirrors `platform.constants.ts` — every profile gets these. */
const SHARED_CORE: ModuleKey[] = [
  'CUSTOMERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
];
const RETAIL_ONLY: ModuleKey[] = [
  'RETAIL_POS',
  'INVENTORY',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'QUICKBOOKS',
];
const RESTAURANT_ONLY: ModuleKey[] = [
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
  // D47 — reservations became a food-service default.
  'RESERVATIONS',
];

const LEGACY_MODULES: ModuleKey[] = [...SHARED_CORE, ...RETAIL_ONLY];
const RESTAURANT_MODULES: ModuleKey[] = [...SHARED_CORE, ...RESTAURANT_ONLY];

function permissionsOf(role: UserRole) {
  const granted = new Set<string>(ROLE_PERMISSIONS[role]);
  return (permission: Permission) => granted.has(permission);
}

/**
 * D93 — the permission predicate for a TEMPLATE role (waiter, kitchen staff,
 * restaurant cashier), which is where the food-service rail defect lived.
 *
 * `permissionsOf` above takes a `UserRole` ENUM, and every restaurant role
 * except the owner is a template with no enum value — which is exactly why a
 * rail that was wrong for the till stayed invisible to this file for so long.
 *
 * Throws on an unknown key rather than returning an empty set: a renamed
 * template would otherwise hand every test a predicate that answers `false` to
 * everything, and a rail asserted to be MISSING an entry passes beautifully
 * when the role holds nothing at all.
 */
function permissionsOfTemplate(key: string) {
  const template = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === key);
  if (!template) {
    throw new Error(
      `No restaurant role template '${key}' — it was renamed or removed, and this test is now asserting nothing.`,
    );
  }
  if (template.permissions.length === 0) {
    throw new Error(`Template '${key}' grants nothing; every assertion against it would be vacuous.`);
  }
  const granted = new Set<string>(template.permissions);
  return (permission: Permission) => granted.has(permission);
}

function nav(
  businessType: string | null,
  modules: ModuleKey[] | null,
  role: UserRole = 'OWNER',
): NavGroup[] {
  return resolveNavigation({
    businessType,
    enabledModules: modules,
    hasPermission: permissionsOf(role),
  });
}

const labels = (groups: NavGroup[]): string[] => groups.flatMap((g) => g.items.map((i) => i.label));
const hrefs = (groups: NavGroup[]): string[] => groups.flatMap((g) => g.items.map((i) => i.href));

// ─────────────────────────────────────────────────────────────────────────────
// Tile Shop is unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe('Tile Shop navigation is behaviourally identical to before Slice 8', () => {
  it('renders exactly the pre-Slice-8 list, in the pre-Slice-8 order', () => {
    // The literal list that shipped before this slice. An exact sequence, not a
    // set: a reordered sidebar is a visible change to an existing screen.
    expect(labels(nav('HARDWARE', LEGACY_MODULES))).toEqual([
      'Dashboard',
      'POS',
      'Sales',
      'Quotations',
      'Returns',
      'Products',
      'Suppliers',
      'Customers',
      'QuickBooks',
      'Settings',
    ]);
  });

  it('keeps its group headings', () => {
    expect(nav('HARDWARE', LEGACY_MODULES).map((g) => g.label)).toEqual([
      null,
      'Operations',
      'Catalog',
      'System',
    ]);
  });

  it('an unregistered business type renders the empty rail, never the retail one (D56/D57)', () => {
    /*
     * TILE_SHOP was removed from the enum (D57) and the registry has no
     * fallback (D56) — the `?? RETAIL_NAV` this replaced is exactly the
     * mechanism that handed HOTEL the wrong screens. A stale value from an old
     * token or a mis-wired caller gets a visibly empty rail, not a plausibly
     * wrong retail one.
     *
     * `RETAIL` was a second probe here until D99 brought the template back. It
     * is registered now, so asserting it renders nothing would assert the
     * opposite of the truth. `GHOST_TYPE` replaces it — a value that cannot
     * ever be registered, which is what the probe always meant.
     */
    expect(nav('TILE_SHOP' as never, LEGACY_MODULES)).toEqual([]);
    expect(nav('GHOST_TYPE' as never, LEGACY_MODULES)).toEqual([]);
    // Positive counterpart, so the two negatives cannot pass by the resolver
    // returning [] for everything.
    expect(labels(nav('HARDWARE', LEGACY_MODULES)).length).toBeGreaterThan(0);
  });

  it('D99 — RETAIL is registered, and gets the retail rail', () => {
    // The counterpart of the probe retired above: the value that used to prove
    // "unregistered renders nothing" must now prove the opposite, or the change
    // above would have quietly weakened the suite by one assertion.
    const retail = labels(nav('RETAIL', LEGACY_MODULES));

    expect(retail.length).toBeGreaterThan(0);
    // Same rail as HARDWARE — RETAIL_NAVIGATION is shared, not forked (D99).
    expect(retail).toEqual(labels(nav('HARDWARE', LEGACY_MODULES)));
  });

  it('marks nothing as upcoming — every retail destination is built', () => {
    const upcoming = nav('HARDWARE', LEGACY_MODULES)
      .flatMap((g) => g.items)
      .filter((i) => i.upcoming);
    expect(upcoming).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Restaurant
// ─────────────────────────────────────────────────────────────────────────────

describe('Restaurant navigation', () => {
  const restaurant = nav('RESTAURANT', RESTAURANT_MODULES);

  it('shows the Restaurant shell', () => {
    // Pilot Change 2 rebuild: POS + Orders replace the standalone Takeaway
    // entry (PO decision 3 — Takeaway is now `POS → Takeaway`).
    //
    // D45: `Menu` is intentionally absent — Restaurant tenants author every
    // sellable item from Products (labelled "Inventory" in the rail) and the
    // POS reads them via `/restaurant/pos-catalogue`. The `/menu` route file
    // still exists for support-only access at `?view=legacy`, but the nav
    // entry is gone.
    expect(labels(restaurant)).toEqual([
      'Dashboard',
      'POS',
      'Orders',
      'Kitchen',
      'Tables',
      // D47 — the reservation calendar.
      'Calendar',
      // Restaurant tenants label the shared product catalogue "Inventory"
      // so it reads as the single authoring surface for menu items. Retail
      // keeps "Products" — asserted in the Tile Shop block above.
      'Inventory',
      'Customers',
      'Sales',
      'Reports',
      'Settings',
    ]);
  });

  it('does not surface a Menu link (D45)', () => {
    // Positive assertion of a D45 negative: the Menu nav entry was removed,
    // and the shape assertion above would still pass a resolver that dropped
    // several entries — this one nails the exact removal.
    const shown = labels(restaurant);
    expect(shown).not.toContain('Menu');
    // Positive control: the retail list also does not contain Menu, so if
    // both flipped to including it the test above and this one would agree.
    // Assert against the RETAIL nav here so the intent is visible.
    expect(labels(nav('HARDWARE', LEGACY_MODULES))).not.toContain('Menu');
  });

  it('shows no retail-only destination', () => {
    // `POS` is no longer retail-only after Pilot Change 2 — it is the
    // shared entry point that dispatches by business type. The other
    // four remain retail-only.
    const shown = labels(restaurant);
    for (const absent of ['Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ absent, shown: shown.includes(absent) }).toEqual({ absent, shown: false });
    }
    // POSITIVE CONTROL: the same names ARE present for a retail tenant, so the
    // absences above are the module filter working rather than an empty result.
    const retail = labels(nav('HARDWARE', LEGACY_MODULES));
    for (const present of ['Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ present, shown: retail.includes(present) }).toEqual({ present, shown: true });
    }
    // And POS is present in BOTH — same label, different implementation
    // behind the dispatcher.
    expect(shown).toContain('POS');
    expect(retail).toContain('POS');
  });

  it('marks every unbuilt destination as upcoming, and no built one', () => {
    // Every Restaurant destination is live: POS + Orders replaced the
    // standalone Takeaway entry in Pilot Change 2, and D45 removed the
    // Menu entry (Products is now the single authoring surface for a
    // Restaurant tenant). Nothing in the sidebar carries the "Soon"
    // marker today.
    const byLabel = Object.fromEntries(
      restaurant.flatMap((g) => g.items).map((i) => [i.label, Boolean(i.upcoming)]),
    );
    expect(byLabel).toEqual({
      Dashboard: false,
      POS: false,
      Orders: false,
      Kitchen: false,
      Tables: false,
      Calendar: false,
      Inventory: false,
      Customers: false,
      Sales: false,
      Reports: false,
      Settings: false,
    });
  });

  it('CAFE and BAKERY resolve to the same list', () => {
    expect(labels(nav('CAFE', RESTAURANT_MODULES))).toEqual(labels(restaurant));
    expect(labels(nav('BAKERY', RESTAURANT_MODULES))).toEqual(labels(restaurant));
  });

  /*
   * D55: "the hotel template is a duplicate of the restaurant template for now"
   * is the whole specification of the third workspace template, and it is a claim
   * about this map — so it is asserted here rather than left to a shared array
   * reference that a later edit could silently split.
   *
   * Both halves matter: equal to restaurant, and (below) not equal to retail. An
   * assertion that hotel merely "has items" would pass for the retail list too.
   */
  it('HOTEL renders the restaurant navigation, exactly — labels, hrefs and groups', () => {
    const hotel = nav('HOTEL', RESTAURANT_MODULES);
    expect(labels(hotel)).toEqual(labels(restaurant));
    expect(hrefs(hotel)).toEqual(hrefs(restaurant));
    expect(hotel.map((g) => g.label)).toEqual(restaurant.map((g) => g.label));
    // Not vacuous: the shared list is non-empty and food-service specific.
    expect(labels(hotel)).toContain('Tables');
    expect(labels(hotel)).toContain('Kitchen');
  });

  it('HOTEL is not the retail navigation', () => {
    expect(labels(nav('HOTEL', RESTAURANT_MODULES))).not.toEqual(
      labels(nav('HARDWARE', LEGACY_MODULES)),
    );
  });

  it('is genuinely different from the retail list', () => {
    expect(labels(restaurant)).not.toEqual(labels(nav('HARDWARE', LEGACY_MODULES)));
  });

  it('still reaches Products — a restaurant owns its own catalogue', () => {
    // `/products` carries no module key on purpose (D35): INVENTORY means stock
    // tracking, not "has a catalogue".
    expect(hrefs(restaurant)).toContain('/products');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both filters
// ─────────────────────────────────────────────────────────────────────────────

describe('module and permission are both required', () => {
  it('a disabled module removes its entry even for an owner', () => {
    const withoutSuppliers = LEGACY_MODULES.filter((m) => m !== 'SUPPLIERS');
    expect(labels(nav('HARDWARE', withoutSuppliers))).not.toContain('Suppliers');
    expect(labels(nav('HARDWARE', LEGACY_MODULES))).toContain('Suppliers');
  });

  it('a missing permission removes its entry even when the module is on', () => {
    // A cashier holds no SETTINGS_MANAGE, so Settings is hidden although the
    // tenant has the module.
    expect(labels(nav('HARDWARE', LEGACY_MODULES, 'CASHIER'))).not.toContain('Settings');
    expect(labels(nav('HARDWARE', LEGACY_MODULES, 'OWNER'))).toContain('Settings');
  });

  it('a cashier sees the operational entries they can actually use', () => {
    const cashier = labels(nav('HARDWARE', LEGACY_MODULES, 'CASHIER'));
    expect(cashier).toContain('POS');
    expect(cashier).toContain('Products');
    expect(cashier).not.toContain('QuickBooks');
    expect(cashier).not.toContain('Suppliers');
  });

  it('an accountant sees the read-only surface, not the tills', () => {
    const accountant = labels(nav('HARDWARE', LEGACY_MODULES, 'ACCOUNTANT'));
    expect(accountant).toContain('QuickBooks');
    expect(accountant).toContain('Suppliers');
    expect(accountant).not.toContain('POS');
  });

  it('a group with no surviving items disappears entirely', () => {
    // Rather than rendering an empty heading, which reads as a broken section.
    //
    // This used to switch off the Operations modules. It cannot any more: the
    // product owner classified `/sales` as shared core, so Operations keeps one
    // entry however many modules are revoked — which the assertion below states
    // outright rather than letting this case quietly stop testing collapse.
    const noSystem = LEGACY_MODULES.filter((m) => !['QUICKBOOKS', 'SETTINGS'].includes(m));
    const groups = nav('HARDWARE', noSystem).map((g) => g.label);

    expect(groups).not.toContain('System');
    expect(groups).toContain('Operations');
  });

  it('Operations survives on sale history alone', () => {
    // The consequence of the shared-core classification, stated positively: with
    // every retail module revoked the section still carries exactly one entry.
    const noRetail = LEGACY_MODULES.filter(
      (m) => !['RETAIL_POS', 'QUOTATIONS', 'RETURNS'].includes(m),
    );
    const operations = nav('HARDWARE', noRetail).find((g) => g.label === 'Operations');

    expect(operations?.items.map((i) => i.label)).toEqual(['Sales']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The unresolved profile
// ─────────────────────────────────────────────────────────────────────────────

describe('an unresolved profile renders nothing rather than a guess', () => {
  it('returns an empty list when the business type is unknown', () => {
    expect(nav(null, LEGACY_MODULES)).toEqual([]);
  });

  it('returns an empty list when the modules are unknown', () => {
    expect(nav('HARDWARE', null)).toEqual([]);
  });

  it('does not fall back to the retail list', () => {
    // The specific bug: a restaurant operator watching POS and QuickBooks flash on
    // every page load, and forever if the profile request failed.
    expect(nav(null, null)).not.toEqual(nav('HARDWARE', LEGACY_MODULES));
    expect(nav(null, null)).toEqual([]);
  });

  it('an unrecognised business type renders nothing rather than a retail guess (D56)', () => {
    /*
     * Inverted from the pre-D56 assertion, on record: the old resolver fell
     * back to the retail list for any unknown string, which is the mechanism
     * that would hand a mis-wired future domain the wrong product. Unknown
     * now behaves like unresolved — visibly empty, never plausibly wrong.
     */
    expect(nav('SOMETHING_NEW', LEGACY_MODULES)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('every navigation entry points somewhere real', () => {
  it('no two entries share an href within one workspace', () => {
    for (const [type, modules] of [
      ['HARDWARE', LEGACY_MODULES],
      ['RESTAURANT', RESTAURANT_MODULES],
    ] as const) {
      const seen = hrefs(nav(type, modules));
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('every href is an absolute app path', () => {
    expect(ALL_NAV_ITEMS.length).toBeGreaterThan(0);
    for (const item of ALL_NAV_ITEMS) {
      expect({ href: item.href, ok: item.href.startsWith('/') }).toEqual({
        href: item.href,
        ok: true,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route gating (Slice 8.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('moduleForPath', () => {
  it('gates the routes a hidden link would otherwise still reach', () => {
    // Exact pairs, not "is not null": a route mapped to the *wrong* module would
    // satisfy a null check while gating on something the tenant happens to have.
    //
    // `/pos` is now shared between workspaces (Pilot Change 2 — a restaurant
    // POS dispatch lives at the same route as the retail checkout). Because
    // the two workspace declarations disagree on the module, the derivation
    // rule resolves `/pos` to `null` at the client; each tenant's *own*
    // required module is still enforced by the API, matching the note in
    // `nav.ts` next to `ROUTE_MODULES`. Asserted as `null` here rather than
    // one of the two, deliberately.
    //
    // `/takeaway` is no longer in the nav — the entry moved to POS mode —
    // so `moduleForPath` returns null. A 307 middleware redirect ships the
    // request to `/pos?mode=takeaway`; the client-side gate never fires on
    // the old path.
    expect([
      ['/quickbooks', moduleForPath('/quickbooks')],
      ['/pos', moduleForPath('/pos')],
      ['/orders', moduleForPath('/orders')],
      ['/quotations', moduleForPath('/quotations')],
      ['/returns', moduleForPath('/returns')],
      ['/suppliers', moduleForPath('/suppliers')],
      ['/customers', moduleForPath('/customers')],
      ['/settings', moduleForPath('/settings')],
      ['/tables', moduleForPath('/tables')],
      ['/takeaway', moduleForPath('/takeaway')],
      ['/kitchen', moduleForPath('/kitchen')],
      // D45: `/menu` is no longer in any workspace's nav, so the derivation
      // table has no entry for it and `moduleForPath` returns null. The
      // route file still exists (support-only fallback at `?view=legacy`
      // + a Restaurant-tenant redirect card), but the client-side module
      // gate no longer fires — the API's own gating is authoritative.
      ['/menu', moduleForPath('/menu')],
    ]).toEqual([
      ['/quickbooks', 'QUICKBOOKS'],
      ['/pos', null],
      ['/orders', 'TABLE_MANAGEMENT'],
      ['/quotations', 'QUOTATIONS'],
      ['/returns', 'RETURNS'],
      ['/suppliers', 'SUPPLIERS'],
      ['/customers', 'CUSTOMERS'],
      ['/settings', 'SETTINGS'],
      ['/tables', 'TABLE_MANAGEMENT'],
      ['/takeaway', null],
      ['/kitchen', 'KITCHEN'],
      ['/menu', null],
    ]);
  });

  it('leaves shared-core routes ungated', () => {
    // `/dashboard`, `/products` and `/sales` are reachable by every profile, and
    // the API gates none of the three. `/sales` is the product owner's explicit
    // classification: completed-sale history is shared core, and `RETAIL_POS`
    // governs taking a sale rather than reading one.
    expect([
      moduleForPath('/dashboard'),
      moduleForPath('/products'),
      moduleForPath('/sales'),
    ]).toEqual([null, null, null]);
  });

  it('gates child routes but not merely similar ones', () => {
    expect(moduleForPath('/quickbooks/sync-log')).toBe('QUICKBOOKS');
    expect(moduleForPath('/products/prd_1/edit')).toBeNull();

    // Prefix matching that ignored segment boundaries would gate this one too.
    expect(moduleForPath('/possible-duplicates')).toBeNull();
    expect(moduleForPath('/menus-archive')).toBeNull();
  });

  it('lets the longest matching prefix win', () => {
    // `/quickbooks/settings` must answer to QuickBooks, never to `/settings`.
    expect(moduleForPath('/quickbooks/settings')).toBe('QUICKBOOKS');
  });

  it('treats an unknown route as ungated rather than blocked', () => {
    // A route the sidebar has never heard of is either a 404 or a page that opted
    // out of navigation; blocking it would break pages this slice never touched.
    expect(moduleForPath('/nothing-here')).toBeNull();
    expect(moduleForPath('/')).toBeNull();
  });

  it('agrees with the navigation list it is derived from, except for shared-route disagreements', () => {
    // The invariant that keeps the two mechanisms from drifting: every item the
    // sidebar filters on a module is a path the gate also blocks, on the same key.
    //
    // Pilot Change 2 introduced one deliberate exception documented in
    // `nav.ts` next to `ROUTE_MODULES`: `/pos` is declared with
    // `RETAIL_POS` on the retail rail and `TABLE_MANAGEMENT` on the
    // restaurant rail. The derivation rule resolves such disagreements to
    // "ungated" at the client so neither workspace can accidentally be
    // stricter than the API; the API refuses the wrong module per-tenant.
    // Asserted here as a named exception rather than "no disagreements",
    // so a future disagreement on a different href is a red test.
    const gatedByNav = ALL_NAV_ITEMS.filter((item) => item.module);
    expect(gatedByNav.length).toBeGreaterThan(0);

    const disagreements = gatedByNav.filter((item) => moduleForPath(item.href) !== item.module);
    const disagreeingHrefs = [...new Set(disagreements.map((item) => item.href))].sort();
    expect(disagreeingHrefs).toEqual(['/pos']);
  });

  it('classifies completed-sale history as shared core in both workspaces', () => {
    // Asserted from the navigation data as well as the gate, because the two are
    // separate mechanisms and the decision has to hold in both. A Restaurant
    // tenant reads its own sale history; a Tile Shop with RETAIL_POS switched off
    // still reads the sales it already took.
    const salesEntries = ALL_NAV_ITEMS.filter((item) => item.href === '/sales');
    expect(salesEntries).toHaveLength(2);
    expect(salesEntries.map((item) => item.module)).toEqual([undefined, undefined]);

    expect(labels(nav('HARDWARE', [...SHARED_CORE]))).toContain('Sales');
    expect(labels(nav('RESTAURANT', RESTAURANT_MODULES))).toContain('Sales');
  });

  it('still hides sale history from a role without the permission', () => {
    // Shared core is not "ungoverned": the permission is what protects it, so the
    // negative has to be proven or the classification reads as an access removal.
    const readers = ROLE_PERMISSIONS.CASHIER as readonly string[];
    expect(readers).toContain(Permission.SALE_READ);

    const withoutSaleRead = (permission: Permission) => permission !== Permission.SALE_READ;
    const groups = resolveNavigation({
      businessType: 'RESTAURANT',
      enabledModules: RESTAURANT_MODULES,
      hasPermission: withoutSaleRead,
    });
    expect(labels(groups)).not.toContain('Sales');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the navigation assertions can actually fail', () => {
  it('a resolver returning everything regardless of module would be detected', () => {
    const restaurant = labels(nav('RESTAURANT', RESTAURANT_MODULES));
    expect(restaurant).not.toContain('QuickBooks');

    const unfiltered = [...restaurant, 'QuickBooks'];
    expect(unfiltered).not.toEqual(restaurant);
    expect(() => expect(unfiltered).not.toContain('QuickBooks')).toThrow();
  });

  it('a resolver returning nothing would be detected too', () => {
    // The other direction, which is what makes every negative above meaningful.
    expect(labels(nav('RESTAURANT', RESTAURANT_MODULES)).length).toBeGreaterThan(0);
    expect(() => expect(labels([])).toContain('Dashboard')).toThrow();
  });

  it('an unresolved profile silently defaulting to retail would be detected', () => {
    const safe = nav(null, null);
    const defaulted = nav('HARDWARE', LEGACY_MODULES);
    expect(safe).not.toEqual(defaulted);
    expect(() => expect(defaulted).toEqual([])).toThrow();
  });

  it('a route gate that matched nothing would be detected', () => {
    // The failure this proof exists for: `moduleForPath` returning `null` for
    // everything gates no route at all, and every "…is ungated" assertion above
    // would still pass. Only a positive result distinguishes the two.
    const gated = ALL_NAV_ITEMS.map((item) => moduleForPath(item.href)).filter(Boolean);
    expect(gated.length).toBeGreaterThan(0);

    const alwaysNull = () => null;
    expect(() => expect(alwaysNull()).toBe('QUICKBOOKS')).toThrow();
  });

  it('a route gate matching on bare prefixes would be detected', () => {
    expect(moduleForPath('/possible-duplicates')).toBeNull();

    // What a `startsWith(href)` implementation would have returned.
    const bare = (path: string) => (path.startsWith('/pos') ? 'RETAIL_POS' : null);
    expect(bare('/possible-duplicates')).toBe('RETAIL_POS');
    expect(() => expect(bare('/possible-duplicates')).toBeNull()).toThrow();
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * D93 — the POS rail entry is gated on what the POS screen can do
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defect: `/pos` in a food-service workspace hung on SALE_CREATE, a RETAIL
 * permission the restaurant till deliberately does not hold (D87). The one role
 * whose job is ringing up takeaway and delivery orders had no POS in its rail,
 * while the server had permitted the whole flow all along.
 *
 * Why the existing file missed it: every test above resolves permissions from
 * `ROLE_PERMISSIONS[UserRole]`, and every restaurant role except the owner is a
 * TEMPLATE with no enum value. The rail was only ever asserted for roles that
 * could not exhibit the bug.
 *
 * The dangerous direction of this change is fail-open — an any-of gate written
 * as all-of-nothing puts Settings and QuickBooks in front of every role — so
 * the negatives below are load-bearing and are mutation-proven at the bottom.
 */
describe('D93 — any-of permission gates', () => {
  const restaurantNav = (key: string) =>
    resolveNavigation({
      businessType: 'RESTAURANT',
      enabledModules: RESTAURANT_MODULES,
      hasPermission: permissionsOfTemplate(key),
    });

  it('the restaurant CASHIER can see POS — the entry the complaint was about', () => {
    const rail = labels(restaurantNav('RESTAURANT_CASHIER'));

    // POSITIVE: the destination that composes takeaway and delivery orders.
    expect(rail).toContain('POS');
    // …reached WITHOUT holding the retail permission it used to hang on, which
    // is the whole point: no grant was made to achieve this.
    expect(permissionsOfTemplate('RESTAURANT_CASHIER')(Permission.SALE_CREATE)).toBe(false);
    expect(permissionsOfTemplate('RESTAURANT_CASHIER')(Permission.TAKEAWAY_CREATE)).toBe(true);
  });

  it('and the till still does NOT get the entries it has no business in', () => {
    const rail = labels(restaurantNav('RESTAURANT_CASHIER'));

    /*
     * D94 (PO, 2026-08-25) — Kitchen LEFT this list: the till watches the board
     * now. Read-only: `KITCHEN_STATUS_UPDATE` stays with the kitchen, and the
     * board's Complete control is gated on it (kitchen-board.tsx:51), so a
     * cashier sees the queue and cannot mark it done.
     */
    expect(rail).toContain('Kitchen');

    // NEGATIVE, paired with the positives so neither can pass on a rail
    // that renders everything or nothing.
    expect(rail).not.toContain('Reports');
    expect(rail).not.toContain('Settings');
    // Tables still hangs on SALE_CREATE and is deliberately NOT part of this
    // change (D93). Asserted so that widening it later is a decision somebody
    // makes on purpose rather than a side effect.
    expect(rail).not.toContain('Tables');
  });

  it('waiter and owner keep POS, so the change is strictly additive', () => {
    expect(labels(restaurantNav('WAITER'))).toContain('POS');
    expect(labels(nav('RESTAURANT', RESTAURANT_MODULES, 'OWNER'))).toContain('POS');
  });

  it('D94 — the till sees the board but cannot work it', () => {
    const till = permissionsOfTemplate('RESTAURANT_CASHIER');

    // The rail entry is KOT_VIEW…
    expect(till(Permission.KOT_VIEW)).toBe(true);
    // …and the capability that changes a ticket is NOT the till's. This pair is
    // the whole point: a read-only board. If the second ever flips, the cashier
    // gains the power to mark food done from behind the counter.
    expect(till(Permission.KITCHEN_STATUS_UPDATE)).toBe(false);
  });

  it('kitchen staff still get no POS, and are not simply getting nothing', () => {
    const rail = labels(restaurantNav('KITCHEN_STAFF'));

    // NEGATIVE…
    expect(rail).not.toContain('POS');
    expect(rail).not.toContain('Orders');
    // …and the POSITIVE that stops it passing on an empty rail.
    expect(rail).toContain('Kitchen');
  });

  it('the /pos gate is exactly the three capabilities, in the shared spec', () => {
    /*
     * Read from FOOD_SERVICE_NAVIGATION, not from ALL_NAV_ITEMS: there are TWO
     * `/pos` entries in the product — retail's, still a single SALE_CREATE,
     * and this one — and `ALL_NAV_ITEMS.find` returns whichever domain was
     * bound first. An earlier draft of this test did exactly that and spread
     * the retail string into a list of characters.
     */
    const pos = FOOD_SERVICE_NAVIGATION.flatMap((g) => g.items).find((i) => i.href === '/pos');
    expect(pos).toBeDefined();
    expect(Array.isArray(pos!.permission)).toBe(true);
    // An EXACT set, not a `toContain`: a permission quietly added here widens
    // who sees the till's screen, and counts would not notice a swap.
    expect([...(pos!.permission as readonly Permission[])].sort()).toEqual(
      [
        Permission.SALE_CREATE,
        Permission.ORDER_SEND_TO_KITCHEN,
        Permission.TAKEAWAY_CREATE,
      ].sort(),
    );
  });

  it('the RETAIL /pos entry is untouched — still a single retail permission', () => {
    // D16: Tile Shop behaviour is not edited to accommodate a restaurant fix.
    const retailPos = RETAIL_NAVIGATION.flatMap((g) => g.items).find((i) => i.href === '/pos');
    expect(retailPos).toBeDefined();
    expect(retailPos!.permission).toBe(Permission.SALE_CREATE);
    expect(Array.isArray(retailPos!.permission)).toBe(false);
  });

  it('FAIL-OPEN TRIPWIRE — a user holding nothing sees only ungated destinations', () => {
    const rail = resolveNavigation({
      businessType: 'RESTAURANT',
      enabledModules: RESTAURANT_MODULES,
      hasPermission: () => false,
    });

    // This is the assertion that catches an any-of written as all-of-nothing.
    // Dashboard is genuinely ungated (shared core); everything else must go.
    expect(labels(rail)).toEqual(['Dashboard']);
    for (const forbidden of ['POS', 'Settings', 'Reports', 'Kitchen', 'Sales', 'Tables']) {
      expect(labels(rail)).not.toContain(forbidden);
    }
    // And the same for retail, where the blast radius includes QuickBooks.
    expect(
      labels(
        resolveNavigation({
          businessType: 'HARDWARE',
          enabledModules: LEGACY_MODULES,
          hasPermission: () => false,
        }),
      ),
    ).toEqual(['Dashboard']);
  });

  it('an ARRAY gate is any-of, not all-of', () => {
    // Holding exactly ONE of the three is enough. Built as a bare predicate
    // rather than from a template so the claim is about the gate, not about
    // whichever role happens to hold what today.
    const onlyTakeaway = (p: Permission) => p === Permission.TAKEAWAY_CREATE;
    const onlyKitchenSend = (p: Permission) => p === Permission.ORDER_SEND_TO_KITCHEN;
    const onlySaleCreate = (p: Permission) => p === Permission.SALE_CREATE;

    for (const holds of [onlyTakeaway, onlyKitchenSend, onlySaleCreate]) {
      expect(
        labels(
          resolveNavigation({
            businessType: 'RESTAURANT',
            enabledModules: RESTAURANT_MODULES,
            hasPermission: holds,
          }),
        ),
      ).toContain('POS');
    }

    // NEGATIVE: holding a permission that is NOT in the set does not open it.
    expect(
      labels(
        resolveNavigation({
          businessType: 'RESTAURANT',
          enabledModules: RESTAURANT_MODULES,
          hasPermission: (p) => p === Permission.PAYMENT_COLLECT,
        }),
      ),
    ).not.toContain('POS');
  });

  it('a single-permission gate still behaves exactly as before', () => {
    // The regression risk of widening the field: entries that were NOT changed
    // must be unaffected. Kitchen is still a plain single-permission gate.
    const onlyKot = (p: Permission) => p === Permission.KOT_VIEW;
    const rail = labels(
      resolveNavigation({
        businessType: 'RESTAURANT',
        enabledModules: RESTAURANT_MODULES,
        hasPermission: onlyKot,
      }),
    );
    expect(rail).toContain('Kitchen');
    expect(rail).not.toContain('POS');
    expect(rail).not.toContain('Orders');
  });

  /*
   * MUTATION PROOFS (D30), inline and in the style used above: each is the
   * implementation somebody could plausibly write instead, shown to produce a
   * DIFFERENT answer to an assertion in this block — so none of the above can
   * be passing for the wrong reason.
   */
  describe('the any-of gate can actually fail', () => {
    const gate = [
      Permission.SALE_CREATE,
      Permission.ORDER_SEND_TO_KITCHEN,
      Permission.TAKEAWAY_CREATE,
    ] as const;
    const till = permissionsOfTemplate('RESTAURANT_CASHIER');
    const kitchen = permissionsOfTemplate('KITCHEN_STAFF');

    /*
     * These two assert against the REAL exported `holdsAnyOf`, contrasted with
     * the implementation somebody would plausibly write instead. An earlier
     * draft compared two LOCAL expressions — `Boolean(gate)` against a literal
     * array is a compile-time constant, so it could never fail whatever the
     * shipped gate did. Decorative assertions of that shape are the exact
     * failure D30 names: indistinguishable from a passing test, and they stop
     * anyone looking again.
     */
    it('M1: all-of instead of any-of hides POS from the till again', () => {
      const shipped = holdsAnyOf(gate, { hasPermission: till });
      const allOf = gate.every((p) => till(p));

      expect(shipped).toBe(true); // what the till gets today
      expect(allOf).toBe(false); // what the mutation would give them
      expect(shipped).not.toBe(allOf);
    });

    it('M2: treating a present gate as satisfied shows POS to kitchen staff', () => {
      const shipped = holdsAnyOf(gate, { hasPermission: kitchen });
      // `!item.permission || …` — the pre-D93 line — reads a non-empty array
      // as "gated", then asks hasPermission(theWholeArray), which is false for
      // everyone: POS would vanish for ALL roles.
      const preD93 = !gate || kitchen(gate as unknown as Permission);
      // …and the opposite slip, treating any present gate as already met.
      const truthyGate = (g: readonly Permission[] | undefined) => Boolean(g);

      expect(shipped).toBe(false); // kitchen staff hold none of the three
      expect(preD93).toBe(false); // …and would lose it even if they did
      expect(truthyGate(gate)).toBe(true); // POS for everyone — the fail-open
      expect(shipped).not.toBe(truthyGate(gate));
      // Positive control: the same shipped gate DOES open for the till, so the
      // false above is about kitchen staff, not about a gate that refuses all.
      expect(holdsAnyOf(gate, { hasPermission: till })).toBe(true);
    });

    /*
     * M3 asserts against the REAL `holdsAnyOf`, not a stand-in. No nav spec
     * carries an empty gate today, so this branch cannot be reached through
     * `resolveNavigation` — and the first draft of this proof compared two
     * local expressions, which passed happily while the actual function fell
     * open. That is precisely the vacuous shape D30 exists to catch.
     */
    it('M3: an empty gate array REFUSES in the real gate, not just in a stand-in', () => {
      const holdsNothing = { hasPermission: () => false };
      const holdsEverything = { hasPermission: () => true };

      // The load-bearing case: an entry whose last permission was deleted
      // disappears, rather than appearing for every role in the product.
      expect(holdsAnyOf([], holdsEverything)).toBe(false);
      expect(holdsAnyOf([], holdsNothing)).toBe(false);

      // Paired controls, so the line above is not passing on a function that
      // refuses everything.
      expect(holdsAnyOf(undefined, holdsNothing)).toBe(true); // ungated
      expect(holdsAnyOf(Permission.TAKEAWAY_CREATE, holdsEverything)).toBe(true);
      expect(holdsAnyOf(Permission.TAKEAWAY_CREATE, holdsNothing)).toBe(false);
      expect(holdsAnyOf([Permission.SALE_CREATE, Permission.TAKEAWAY_CREATE], { hasPermission: till }))
        .toBe(true);
      expect(holdsAnyOf([Permission.SALE_CREATE], { hasPermission: till })).toBe(false);
    });

    it('M4: the gate is not handed an index — a bare `.some(hasPermission)` would be', () => {
      /*
       * `[].some(fn)` calls fn(value, index, array). `hasPermission` ignores
       * the extras today, so this is latent rather than live — but a predicate
       * that ever looks at its second argument would start answering a
       * different question, silently, for array gates only.
       */
      const seen: number[] = [];
      holdsAnyOf([Permission.SALE_CREATE, Permission.TAKEAWAY_CREATE], {
        hasPermission: (...args: unknown[]) => {
          seen.push(args.length);
          return false;
        },
      });
      expect(seen).toEqual([1, 1]);
      expect(seen).not.toContain(3);
    });
  });
});

/**
 * D99 (2.8) — D93 verification for the Retail rail.
 *
 * D93's rule: **a rail entry is gated on what the screen can do.** Its failure
 * was `SALE_CREATE` — a retail permission — gating the restaurant `/pos` entry,
 * so a permission had become a proxy for "may use the floor screens" and the
 * proxy had started lying.
 *
 * The dangerous direction is fail-open, so the empty-gate case is proven against
 * the real exported `holdsAnyOf` rather than a local re-expression.
 */
describe('2.8 — the Retail rail gates on capability, not on proxies', () => {
  const RETAIL_MODULES_ALL: ModuleKey[] = [
    ...SHARED_CORE,
    ...RETAIL_ONLY.filter((m) => m !== 'QUICKBOOKS'),
  ];

  it('gates each entry on the permission that names what its screen does', () => {
    // An exact map, so a future entry gated on a borrowed permission is a
    // failing test rather than a plausible-looking sidebar. Every pair below is
    // the screen's OWN capability: /returns on RETURN_READ, not on SALE_CREATE.
    const gates = nav('RETAIL', RETAIL_MODULES_ALL)
      .flatMap((g) => g.items)
      .map((i) => [i.href, i.permission ?? null]);

    expect(gates).toEqual([
      ['/dashboard', null],
      ['/pos', Permission.SALE_CREATE],
      ['/sales', Permission.SALE_READ],
      ['/quotations', Permission.QUOTATION_READ],
      ['/returns', Permission.RETURN_READ],
      ['/products', Permission.PRODUCT_READ],
      ['/suppliers', Permission.SUPPLIER_READ],
      ['/customers', Permission.CUSTOMER_READ],
      ['/settings', Permission.SETTINGS_MANAGE],
    ]);
  });

  it('hides QuickBooks by MODULE, not by withholding a permission', () => {
    // The retail descriptor omits the QUICKBOOKS module, so the shared rail's
    // entry never renders. Deleting the entry from RETAIL_NAVIGATION instead
    // would fork a list Hardware also uses, to remove a line the module gate
    // already removes.
    const withoutModule = nav('RETAIL', RETAIL_MODULES_ALL).flatMap((g) => g.items);
    expect(withoutModule.map((i) => i.href)).not.toContain('/quickbooks');

    // POSITIVE CONTROL: the entry exists and the permission is held — only the
    // module is missing. Without this the assertion above would pass even if the
    // entry had been deleted or the permission revoked.
    const withModule = nav('RETAIL', [...RETAIL_MODULES_ALL, 'QUICKBOOKS']).flatMap((g) => g.items);
    expect(withModule.map((i) => i.href)).toContain('/quickbooks');
  });

  it('carries no restaurant destination', () => {
    const hrefs = nav('RETAIL', RETAIL_MODULES_ALL)
      .flatMap((g) => g.items)
      .map((i) => i.href);

    for (const restaurantOnly of ['/tables', '/kitchen', '/orders', '/calendar']) {
      expect(hrefs).not.toContain(restaurantOnly);
    }
  });

  it('deliberately omits /reports — that screen is restaurant analytics', () => {
    // Checked during the 2.8 audit and nearly "fixed" into a bug. A Retail
    // Owner holds REPORT_READ and the REPORTING module is in SHARED_CORE, so the
    // gate would pass — but `/reports` renders `<RestaurantReports>` and is
    // described as "waiter performance, voids and channels". A door that opens
    // onto the wrong room is worse than no door.
    //
    // Retail reporting is Phase 8 (8.2 sales by variant, 8.4 margin, 8.6 tax by
    // rate). The entry belongs there, with a screen behind it.
    const hrefs = nav('RETAIL', RETAIL_MODULES_ALL)
      .flatMap((g) => g.items)
      .map((i) => i.href);

    expect(hrefs).not.toContain('/reports');
    // The gate really would have passed — this is what makes the omission a
    // decision rather than an accident of permissions.
    expect(ROLE_PERMISSIONS.OWNER).toContain(Permission.REPORT_READ);
    expect(SHARED_CORE).toContain('REPORTING');
  });

  it('a Cashier sees the till and its history, and nothing administrative', () => {
    const hrefs = nav('RETAIL', RETAIL_MODULES_ALL, 'CASHIER')
      .flatMap((g) => g.items)
      .map((i) => i.href);

    expect(hrefs).toContain('/pos');
    expect(hrefs).toContain('/returns');
    // Settings is SETTINGS_MANAGE, which a cashier does not hold — the gate is
    // doing the work, not a hardcoded role check.
    expect(hrefs).not.toContain('/settings');
    expect(hrefs).not.toContain('/suppliers');
  });

  it('an empty gate array REFUSES, using the real holdsAnyOf', () => {
    // D93: the dangerous direction is fail-open. An any-of gate written as
    // all-of-nothing would put Settings in front of every role. Proven against
    // the exported function, because the first draft of this proof in D93
    // compared two local expressions and passed while the real one fell open.
    const grantsEverything = { hasPermission: () => true };

    expect(holdsAnyOf([], grantsEverything)).toBe(false);
    // POSITIVE CONTROLS either side, so the assertion cannot pass by the
    // function refusing everything.
    expect(holdsAnyOf(undefined, { hasPermission: () => false })).toBe(true);
    expect(holdsAnyOf([Permission.SALE_CREATE], grantsEverything)).toBe(true);
  });
});
