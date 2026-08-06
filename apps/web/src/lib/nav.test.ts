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
    expect(labels(nav('TILE_SHOP', LEGACY_MODULES))).toEqual([
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
    expect(nav('TILE_SHOP', LEGACY_MODULES).map((g) => g.label)).toEqual([
      null,
      'Operations',
      'Catalog',
      'System',
    ]);
  });

  it('HARDWARE and RETAIL resolve to the same list', () => {
    const tile = labels(nav('TILE_SHOP', LEGACY_MODULES));
    expect(labels(nav('HARDWARE', LEGACY_MODULES))).toEqual(tile);
    expect(labels(nav('RETAIL', LEGACY_MODULES))).toEqual(tile);
  });

  it('marks nothing as upcoming — every retail destination is built', () => {
    const upcoming = nav('TILE_SHOP', LEGACY_MODULES)
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
    expect(labels(restaurant)).toEqual([
      'Dashboard',
      'Tables',
      'Takeaway',
      'Kitchen',
      'Menu',
      'Products',
      'Customers',
      'Sales',
      'Settings',
    ]);
  });

  it('shows no retail-only destination', () => {
    const shown = labels(restaurant);
    for (const absent of ['POS', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ absent, shown: shown.includes(absent) }).toEqual({ absent, shown: false });
    }
    // POSITIVE CONTROL: the same names ARE present for a retail tenant, so the
    // absences above are the module filter working rather than an empty result.
    const retail = labels(nav('TILE_SHOP', LEGACY_MODULES));
    for (const present of ['POS', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ present, shown: retail.includes(present) }).toEqual({ present, shown: true });
    }
  });

  it('marks every unbuilt destination as upcoming, and no built one', () => {
    const byLabel = Object.fromEntries(
      restaurant.flatMap((g) => g.items).map((i) => [i.label, Boolean(i.upcoming)]),
    );
    expect(byLabel).toEqual({
      Dashboard: false,
      Tables: true,
      Takeaway: true,
      Kitchen: true,
      Menu: true,
      Products: false,
      Customers: false,
      Sales: false,
      Settings: false,
    });
  });

  it('CAFE and BAKERY resolve to the same list', () => {
    expect(labels(nav('CAFE', RESTAURANT_MODULES))).toEqual(labels(restaurant));
    expect(labels(nav('BAKERY', RESTAURANT_MODULES))).toEqual(labels(restaurant));
  });

  it('is genuinely different from the retail list', () => {
    expect(labels(restaurant)).not.toEqual(labels(nav('TILE_SHOP', LEGACY_MODULES)));
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
    expect(labels(nav('TILE_SHOP', withoutSuppliers))).not.toContain('Suppliers');
    expect(labels(nav('TILE_SHOP', LEGACY_MODULES))).toContain('Suppliers');
  });

  it('a missing permission removes its entry even when the module is on', () => {
    // A cashier holds no SETTINGS_MANAGE, so Settings is hidden although the
    // tenant has the module.
    expect(labels(nav('TILE_SHOP', LEGACY_MODULES, 'CASHIER'))).not.toContain('Settings');
    expect(labels(nav('TILE_SHOP', LEGACY_MODULES, 'OWNER'))).toContain('Settings');
  });

  it('a cashier sees the operational entries they can actually use', () => {
    const cashier = labels(nav('TILE_SHOP', LEGACY_MODULES, 'CASHIER'));
    expect(cashier).toContain('POS');
    expect(cashier).toContain('Products');
    expect(cashier).not.toContain('QuickBooks');
    expect(cashier).not.toContain('Suppliers');
  });

  it('an accountant sees the read-only surface, not the tills', () => {
    const accountant = labels(nav('TILE_SHOP', LEGACY_MODULES, 'ACCOUNTANT'));
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
    const groups = nav('TILE_SHOP', noSystem).map((g) => g.label);

    expect(groups).not.toContain('System');
    expect(groups).toContain('Operations');
  });

  it('Operations survives on sale history alone', () => {
    // The consequence of the shared-core classification, stated positively: with
    // every retail module revoked the section still carries exactly one entry.
    const noRetail = LEGACY_MODULES.filter(
      (m) => !['RETAIL_POS', 'QUOTATIONS', 'RETURNS'].includes(m),
    );
    const operations = nav('TILE_SHOP', noRetail).find((g) => g.label === 'Operations');

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
    expect(nav('TILE_SHOP', null)).toEqual([]);
  });

  it('does not fall back to the retail list', () => {
    // The specific bug: a restaurant operator watching POS and QuickBooks flash on
    // every page load, and forever if the profile request failed.
    expect(nav(null, null)).not.toEqual(nav('TILE_SHOP', LEGACY_MODULES));
    expect(nav(null, null)).toEqual([]);
  });

  it('an unrecognised business type falls back to retail rather than breaking', () => {
    // A new BusinessType added server-side must not blank the sidebar; retail is
    // the safe default because it is the existing product.
    expect(labels(nav('SOMETHING_NEW', LEGACY_MODULES))).toEqual(
      labels(nav('TILE_SHOP', LEGACY_MODULES)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('every navigation entry points somewhere real', () => {
  it('no two entries share an href within one workspace', () => {
    for (const [type, modules] of [
      ['TILE_SHOP', LEGACY_MODULES],
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
    expect([
      ['/quickbooks', moduleForPath('/quickbooks')],
      ['/pos', moduleForPath('/pos')],
      ['/quotations', moduleForPath('/quotations')],
      ['/returns', moduleForPath('/returns')],
      ['/suppliers', moduleForPath('/suppliers')],
      ['/customers', moduleForPath('/customers')],
      ['/settings', moduleForPath('/settings')],
      ['/tables', moduleForPath('/tables')],
      ['/takeaway', moduleForPath('/takeaway')],
      ['/kitchen', moduleForPath('/kitchen')],
      ['/menu', moduleForPath('/menu')],
    ]).toEqual([
      ['/quickbooks', 'QUICKBOOKS'],
      ['/pos', 'RETAIL_POS'],
      ['/quotations', 'QUOTATIONS'],
      ['/returns', 'RETURNS'],
      ['/suppliers', 'SUPPLIERS'],
      ['/customers', 'CUSTOMERS'],
      ['/settings', 'SETTINGS'],
      ['/tables', 'TABLE_MANAGEMENT'],
      ['/takeaway', 'TAKEAWAY'],
      ['/kitchen', 'KITCHEN'],
      ['/menu', 'MENU_MANAGEMENT'],
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

  it('agrees with the navigation list it is derived from', () => {
    // The invariant that keeps the two mechanisms from drifting: every item the
    // sidebar filters on a module is a path the gate also blocks, on the same key.
    // No exemptions — once `/sales` was classified shared core, nothing in either
    // list declares a module the gate does not enforce.
    const gatedByNav = ALL_NAV_ITEMS.filter((item) => item.module);
    expect(gatedByNav.length).toBeGreaterThan(0);

    const disagreements = gatedByNav.filter((item) => moduleForPath(item.href) !== item.module);
    expect(disagreements.map((item) => item.href)).toEqual([]);
  });

  it('classifies completed-sale history as shared core in both workspaces', () => {
    // Asserted from the navigation data as well as the gate, because the two are
    // separate mechanisms and the decision has to hold in both. A Restaurant
    // tenant reads its own sale history; a Tile Shop with RETAIL_POS switched off
    // still reads the sales it already took.
    const salesEntries = ALL_NAV_ITEMS.filter((item) => item.href === '/sales');
    expect(salesEntries).toHaveLength(2);
    expect(salesEntries.map((item) => item.module)).toEqual([undefined, undefined]);

    expect(labels(nav('TILE_SHOP', [...SHARED_CORE]))).toContain('Sales');
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
    const defaulted = nav('TILE_SHOP', LEGACY_MODULES);
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
