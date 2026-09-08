/**
 * Workspace configuration, rendered (Slice 8.7).
 *
 * The claim worth testing is that the page is **read-only** and that it reports
 * the profile it was given rather than a default. "Read-only" is asserted by
 * enumerating interactive roles — a later edit that adds a mode selector fails
 * here rather than shipping a one-click stock corruption — and paired with a
 * positive assertion that the values are actually on screen, so a page that
 * rendered nothing could not pass.
 */
import { domainFor } from '@hardware-pos/shared';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Permission, ROLE_PERMISSIONS, type UserRole } from '@/lib/permissions';
import type { EffectiveBusinessProfile, ModuleKey } from '@/lib/platform-api';
import { MODULE_LABELS } from '@/lib/platform-labels';

// ── boundaries ───────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let role: UserRole = 'OWNER';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { role, tenantId: 't' } },
    loading: false,
    isAuthenticated: true,
    hasPermission: (p: Permission) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p),
    logout: vi.fn(),
  }),
}));

let profileState: {
  status: 'loading' | 'ready' | 'error';
  profile: EffectiveBusinessProfile | null;
};

vi.mock('@/lib/platform-profile', () => ({
  useEffectiveProfile: () => ({
    ...profileState,
    inventoryMode: profileState.profile?.inventoryMode ?? null,
    refresh: vi.fn(),
  }),
}));

const BusinessSettingsPage = (await import('./page')).default;

// ── helpers ──────────────────────────────────────────────────────────────────

const SHARED_CORE: ModuleKey[] = [
  'CUSTOMERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
];
const LEGACY: ModuleKey[] = [
  ...SHARED_CORE,
  'RETAIL_POS',
  'INVENTORY',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'QUICKBOOKS',
];
const RESTAURANT: ModuleKey[] = [
  ...SHARED_CORE,
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
];

function show(
  overrides: Partial<EffectiveBusinessProfile> = {},
  options: { status?: 'loading' | 'ready' | 'error'; as?: UserRole } = {},
) {
  role = options.as ?? 'OWNER';
  profileState = {
    status: options.status ?? 'ready',
    profile:
      options.status && options.status !== 'ready'
        ? null
        : {
            source: 'EXPLICIT',
            // D57: the pilot's value; TILE_SHOP was removed from the enum.
            businessType: 'HARDWARE',
            inventoryMode: 'QUICKBOOKS',
            accountingProvider: 'QUICKBOOKS',
            enabledModules: LEGACY,
            capabilities: domainFor('HARDWARE').capabilities,
            version: 1,
            updatedAt: null,
            ...overrides,
          },
  };
  return render(<BusinessSettingsPage />);
}

afterEach(() => {
  cleanup();
  role = 'OWNER';
});

// ─────────────────────────────────────────────────────────────────────────────

describe('what the page reports', () => {
  it('describes a QuickBooks hardware tenant in the operator’s words (D57: label was “Tile shop”)', () => {
    show();

    expect(screen.getByText('Hardware store')).toBeTruthy();
    expect(screen.getByText('Tracked in QuickBooks Online')).toBeTruthy();
    expect(screen.getByText('QuickBooks Online')).toBeTruthy();
  });

  it('describes a local restaurant differently', () => {
    show({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
      enabledModules: RESTAURANT,
    });

    expect(screen.getByText('Restaurant')).toBeTruthy();
    expect(screen.getByText('Tracked in AxloPOS')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    // The two profiles must not converge on the same screen.
    expect(screen.queryByText('Tracked in QuickBooks Online')).toBeNull();
  });

  it('never prints a raw enum value', () => {
    show({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
      enabledModules: RESTAURANT,
    });

    for (const raw of ['RESTAURANT', 'LOCAL', 'TABLE_MANAGEMENT', 'MENU_MANAGEMENT']) {
      expect({ raw, printed: document.body.textContent?.includes(raw) ?? false }).toEqual({
        raw,
        printed: false,
      });
    }
  });
});

/*
 * D95 — the "Not included" column is gone, for every business template
 * including the Tile Shop's. What a workspace includes is not changeable, so an
 * inventory of the absent was a list of things nobody can act on.
 *
 * These tests keep their shape: each still asserts BOTH what the column shows
 * and what it must not, because "Included lists the right modules" is also what
 * a column rendering every label would produce. The exact-set assertion that
 * used to span the two columns now runs against the one that remains — dropping
 * it entirely was the tempting move and would have left the positives with
 * nothing pinning them.
 */
describe('included features', () => {
  it('lists a restaurant’s features and not the retail ones', () => {
    show({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
      enabledModules: RESTAURANT,
    });

    const included = within('Included');

    expect(included).toContain(MODULE_LABELS.TABLE_MANAGEMENT);
    expect(included).toContain(MODULE_LABELS.KITCHEN);
    // NEGATIVE — the half that makes the positives mean something.
    expect(included).not.toContain(MODULE_LABELS.QUICKBOOKS);
    expect(included).not.toContain(MODULE_LABELS.QUOTATIONS);
  });

  it('lists a Tile Shop’s features the other way round', () => {
    show();

    expect(within('Included')).toContain(MODULE_LABELS.QUICKBOOKS);
    expect(within('Included')).not.toContain(MODULE_LABELS.TABLE_MANAGEMENT);
  });

  it('shows exactly the enabled modules — no more, no fewer', () => {
    // The set assertion the two above depend on. It used to span both columns;
    // with one column left it pins that column against the profile's own list,
    // which is a stronger claim than "contains these two".
    show({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
      enabledModules: RESTAURANT,
    });

    const included = within('Included');
    expect([...included].sort()).toEqual(RESTAURANT.map((key) => MODULE_LABELS[key]).sort());
  });

  it('D95 — there is no "Not included" column any more', () => {
    show();

    // NEGATIVE, paired with a positive in the same test so it cannot pass on a
    // page that rendered nothing at all.
    expect(screen.queryByText('Not included')).toBeNull();
    expect(screen.queryByText(/Every available feature is included/)).toBeNull();
    expect(screen.getByText('Included')).toBeTruthy();
  });
});

describe('a legacy tenant is not treated as unconfigured', () => {
  it('calls the configuration standard and offers nothing to finish', () => {
    show({ source: 'LEGACY_DEFAULT', version: null });

    expect(screen.getByText('Standard')).toBeTruthy();
    expect(screen.getByText(/Nothing needs to be set up/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/finish setting up|complete your setup/i);
  });

  it('says something different for an explicit profile', () => {
    show({ source: 'EXPLICIT' });

    expect(screen.getByText('Set for this workspace')).toBeTruthy();
    expect(screen.queryByText('Standard')).toBeNull();
  });
});

describe('the page is read-only', () => {
  it('offers no control that could change the configuration', () => {
    show();

    // Enumerated rather than spot-checked: an editable control added later is
    // exactly the regression this slice's rationale forbids.
    for (const role of ['button', 'textbox', 'combobox', 'checkbox', 'switch', 'radio'] as const) {
      expect({ role, found: screen.queryAllByRole(role).length }).toEqual({ role, found: 0 });
    }
  });

  it('still renders the configuration it refuses to edit', () => {
    // Pairs with the above: a page rendering nothing also has no controls.
    show();
    expect(screen.getByText('Hardware store')).toBeTruthy();
  });

  it('D95 — no longer tells the reader to contact support about it', () => {
    // The paragraph said a change was possible through support. It is not: the
    // inventory-mode transitions it referred to have no migration, and the PO
    // removed the instruction rather than leave one nobody can carry out.
    show();

    expect(screen.queryByText(/Contact support/)).toBeNull();
    expect(screen.queryByText(/not self-service/)).toBeNull();
    // Positive control: the page did render.
    expect(screen.getByText('Hardware store')).toBeTruthy();
  });
});

describe('states other than ready', () => {
  it('shows no configuration while loading', () => {
    show({}, { status: 'loading' });

    expect(screen.getByRole('status').textContent).toBe('Loading configuration…');
    expect(screen.queryByText('Hardware store')).toBeNull();
  });

  it('refuses to guess after a failed read', () => {
    show({}, { status: 'error' });

    expect(screen.getByText('Configuration unavailable')).toBeTruthy();
    expect(screen.queryByText('Hardware store')).toBeNull();
  });

  it('refuses a cashier who typed the URL', () => {
    show({}, { as: 'CASHIER' });

    expect(screen.getByText('You don’t have access to settings')).toBeTruthy();
    expect(screen.queryByText('Hardware store')).toBeNull();
  });

  it('admits an admin', () => {
    // The other direction — a page that refused everyone would pass the above.
    show({}, { as: 'ADMIN' });
    expect(screen.getByText('Hardware store')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the read-only assertions can actually fail', () => {
  it('a button on the page would be detected', () => {
    show();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();

    render(<button type="button">Change inventory mode</button>);
    expect(() => expect(screen.queryAllByRole('button')).toHaveLength(0)).toThrow();
  });

  it('a hard-coded QuickBooks screen would be detected', () => {
    // The specific regression: rendering the legacy defaults regardless of the
    // profile. A restaurant must not see QuickBooks under "Included".
    show({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
      enabledModules: RESTAURANT,
    });
    expect(within('Included')).not.toContain(MODULE_LABELS.QUICKBOOKS);

    const hardCoded = [MODULE_LABELS.QUICKBOOKS];
    expect(() => expect(hardCoded).not.toContain(MODULE_LABELS.QUICKBOOKS)).toThrow();
  });
});

/**
 * The badge labels listed under the given heading.
 *
 * Element-wise rather than a substring search of the section's text: "Kitchen" is
 * a prefix of "Kitchen display", so a text search reports a module as present in a
 * column it is absent from. That is precisely the vacuous-pass D30 forbids, and it
 * was caught by this spec before the assertion was believed.
 */
function within(heading: string): string[] {
  const section = screen.getByText(heading).closest('section');
  if (!section) throw new Error(`No section for heading "${heading}"`);

  const labels = Array.from(section.querySelectorAll('span'), (el) => el.textContent ?? '');
  // A selector that matched nothing would make every `not.toContain` pass.
  // D95 removed the empty-state fallback this used to allow for, so the guard
  // is now unconditional — which is stronger.
  if (labels.length === 0) {
    throw new Error(`No badges found under "${heading}"`);
  }
  return labels;
}
