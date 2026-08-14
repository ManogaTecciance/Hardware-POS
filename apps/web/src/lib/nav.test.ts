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

import { ALL_NAV_ITEMS, moduleForPath, resolveNavigation, type NavGroup } from './nav';
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
     * TILE_SHOP and RETAIL were removed from the enum (D57), and the registry
     * has no fallback (D56) — the `?? RETAIL_NAV` this replaced is exactly
     * the mechanism that handed HOTEL the wrong screens. A stale value from
     * an old token or a mis-wired caller gets a visibly empty rail, not a
     * plausibly wrong retail one.
     */
    expect(nav('TILE_SHOP' as never, LEGACY_MODULES)).toEqual([]);
    expect(nav('RETAIL' as never, LEGACY_MODULES)).toEqual([]);
    // Positive counterpart, so the two negatives cannot pass by the resolver
    // returning [] for everything.
    expect(labels(nav('HARDWARE', LEGACY_MODULES)).length).toBeGreaterThan(0);
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
