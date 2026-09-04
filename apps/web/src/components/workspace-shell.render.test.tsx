/**
 * The workspace shell, rendered (Slice 8).
 *
 * Covers what `nav.test.ts` cannot: that the sidebar actually draws what the
 * resolver returns, that the unresolved state is a neutral placeholder rather than
 * a flash of retail navigation, that the login form exposes the workspace field and
 * reacts to `WORKSPACE_REQUIRED`, and that every control has an accessible name.
 */
import { domainFor } from '@hardware-pos/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { Permission, ROLE_PERMISSIONS, type UserRole } from '@/lib/permissions';
import type { EffectiveBusinessProfile, ModuleKey } from '@/lib/platform-api';

// ── boundaries ───────────────────────────────────────────────────────────────

const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();

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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => searchParams,
  usePathname: () => '/dashboard',
}));

let role: UserRole = 'OWNER';
const loginWithEmail = vi.fn();

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { role, tenantId: 't' } },
    loading: false,
    isAuthenticated: false,
    hasPermission: (p: Permission) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p),
    loginWithEmail,
    logout: vi.fn(),
  }),
}));

let profileState: {
  status: 'loading' | 'ready' | 'error';
  profile: EffectiveBusinessProfile | null;
};

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    ...profileState,
    inventoryMode: profileState.profile?.inventoryMode ?? null,
    refresh: vi.fn(),
  }),
}));

// Must match `SidebarValue` exactly — a partial stub reaches the component as a
// missing function and fails with "closeMobile is not a function", which looks
// like a component bug rather than a mock bug.
vi.mock('@/lib/sidebar', () => ({
  useSidebar: () => ({
    collapsed: false,
    toggleCollapsed: vi.fn(),
    mobileOpen: false,
    openMobile: vi.fn(),
    closeMobile: vi.fn(),
    hydrated: true,
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { Sidebar } = await import('@/components/sidebar');
const LoginPage = (await import('@/app/login/page')).default;

// ── helpers ──────────────────────────────────────────────────────────────────

const SHARED_CORE: ModuleKey[] = ['CUSTOMERS', 'REPORTING', 'USERS', 'BRANCHES', 'SETTINGS', 'BRANDING'];
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

function profile(businessType: string, enabledModules: ModuleKey[]): EffectiveBusinessProfile {
  return {
    source: 'EXPLICIT',
    businessType: businessType as EffectiveBusinessProfile['businessType'],
    inventoryMode: businessType === 'RESTAURANT' ? 'LOCAL' : 'QUICKBOOKS',
    accountingProvider: businessType === 'RESTAURANT' ? 'NONE' : 'QUICKBOOKS',
    enabledModules,
    // D56: resolved exactly as the server would resolve it.
    capabilities: domainFor(businessType as EffectiveBusinessProfile['businessType']).capabilities,
    version: 1,
    updatedAt: null,
  };
}

/**
 * Type into a React-controlled input.
 *
 * Assigning `.value` directly does not fire React's synthetic onChange — React
 * tracks the last value it set and treats an identical-looking write as a no-op —
 * so the component never sees the change and the assertion tests nothing.
 */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * The desktop rail's navigation landmark.
 *
 * Exact name, not a regex: the mobile drawer renders a second landmark called
 * "Main (mobile)", and `/main/i` matches both. Every query below scopes to this
 * one so an assertion cannot pass because the *other* copy happened to contain
 * what it was looking for.
 */
function mainNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main' });
}

function navLinks(): string[] {
  return within(mainNav())
    .queryAllByRole('link')
    .map((a) => a.textContent?.trim() ?? '');
}

beforeAll(() => {
  window.scrollTo = () => undefined;
});

beforeEach(() => {
  vi.clearAllMocks();
  role = 'OWNER';
  searchParams = new URLSearchParams();
  profileState = { status: 'ready', profile: profile('HARDWARE', LEGACY) };
  window.localStorage.clear();
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

describe('8.3 — the sidebar draws what the resolver returns', () => {
  it('a Tile Shop tenant sees the retail navigation', async () => {
    render(<Sidebar />);
    await settle();
    const links = navLinks().join(' | ');
    for (const expected of ['POS', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ expected, present: links.includes(expected) }).toEqual({ expected, present: true });
    }
  });

  it('a Restaurant tenant sees the Restaurant shell and no retail-only entries', async () => {
    // Pilot Change 2: `POS` is now shared between workspaces (it dispatches
    // to a restaurant workspace inside `app/(app)/pos/page.tsx`), and
    // Takeaway is no longer a top-level destination — it lives as a POS
    // mode. `Orders` is the new unified queue.
    profileState = { status: 'ready', profile: profile('RESTAURANT', RESTAURANT) };
    render(<Sidebar />);
    await settle();
    const links = navLinks().join(' | ');

    // D103 — 'Menu' is the products entry's food-service label (href
    // /products; the legacy /menu route still has no entry — nav.test.ts
    // pins that by href, which a label substring check here cannot).
    for (const expected of ['POS', 'Orders', 'Tables', 'Kitchen', 'Menu']) {
      expect({ expected, present: links.includes(expected) }).toEqual({ expected, present: true });
    }
    for (const absent of ['Takeaway', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect({ absent, present: links.includes(absent) }).toEqual({ absent, present: false });
    }
  });

  it('every built Restaurant destination is rendered without the "Soon" marker', async () => {
    // Every Restaurant destination is live — no entry uses the upcoming
    // marker today. The mechanism still matters: if a future entry
    // regresses and starts advertising "Soon" over a live route, the shell
    // claims a feature is coming that is already there.
    profileState = { status: 'ready', profile: profile('RESTAURANT', RESTAURANT) };
    render(<Sidebar />);
    await settle();
    // D103 — restaurant tenants label the shared product catalogue "Menu";
    // Tile Shop / retail keeps "Products". If both labels ever regress to
    // the same string, the sidebar disambiguation is gone. (D45 still holds:
    // the legacy /menu route has no entry — the label points at /products.)
    for (const name of ['POS', 'Orders', 'Tables', 'Kitchen', 'Menu']) {
      const link = within(mainNav()).getByRole('link', { name: new RegExp(name, 'i') });
      expect({ name, hasSoon: /soon/i.test(link.textContent ?? '') }).toEqual({
        name,
        hasSoon: false,
      });
    }
    // Positive control for the marker mechanism itself: the shell keeps the
    // rendering path alive even though no entry currently uses it, so this
    // assertion would fail — proving the negatives above are real — if the
    // mechanism silently stopped rendering "Soon" and started rendering
    // nothing regardless of `item.upcoming`.
    const { container } = render(
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Soon
      </span>,
    );
    expect(container.textContent).toMatch(/soon/i);
  });

  it('7/8 — an unresolved profile shows a neutral placeholder, not retail navigation', async () => {
    profileState = { status: 'loading', profile: null };
    render(<Sidebar />);
    await settle();
    expect(navLinks()).toEqual([]);
    expect(within(mainNav()).getByRole('status').textContent).toMatch(/loading/i);
    expect(document.body.textContent).not.toMatch(/quickbooks|quotations/i);
  });

  it('8 — a failed profile request shows no navigation and says so', async () => {
    profileState = { status: 'error', profile: null };
    render(<Sidebar />);
    await settle();
    expect(navLinks()).toEqual([]);
    expect(within(mainNav()).getByRole('status').textContent).toMatch(/unavailable/i);
  });

  /*
   * D89 — the footer note names an external system or renders nothing.
   *
   * Asserted as a PAIR in one test: the QuickBooks sentence must survive
   * verbatim (D16 — Tile Shop wording is not edited to accommodate a
   * restaurant change) and the AxloPOS sentence must be gone. Split into two
   * tests, a mistake that deleted the whole footer would leave the negative
   * green and read as a pass.
   */
  it('D89 — the footer names QuickBooks and says nothing at all for AxloPOS', async () => {
    profileState = { status: 'ready', profile: profile('HARDWARE', LEGACY) };
    const tileShop = render(<Sidebar />);
    await settle();
    expect(tileShop.container.textContent).toContain(
      'QuickBooks is the inventory & accounting master.',
    );

    profileState = { status: 'ready', profile: profile('RESTAURANT', RESTAURANT) };
    const restaurant = render(<Sidebar />);
    await settle();
    expect(restaurant.container.textContent).not.toMatch(/managed in AxloPOS/i);
    // …and no empty divider left behind where the sentence used to sit: the
    // note's container is gone, not merely blank.
    expect(restaurant.container.querySelectorAll('.border-t.border-border.p-4')).toHaveLength(0);
  });

  it('permission gating still applies inside a workspace', async () => {
    role = 'CASHIER';
    render(<Sidebar />);
    await settle();
    const links = navLinks().join(' | ');
    expect(links).toContain('POS');
    expect(links).not.toContain('QuickBooks');
    expect(links).not.toContain('Settings');
  });
});

describe('accessibility — the shell is navigable without sight or a mouse', () => {
  it('the navigation landmark is labelled', async () => {
    render(<Sidebar />);
    await settle();
    expect(mainNav()).toBeDefined();
    // Both landmarks are labelled, and distinctly — two navs both called "Main"
    // is indistinguishable noise to a screen-reader user.
    const names = screen
      .getAllByRole('navigation')
      .map((n) => n.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('every navigation entry is a focusable link with an accessible name', async () => {
    render(<Sidebar />);
    await settle();
    const links = within(mainNav()).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.tagName).toBe('A');
      expect((link.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(link.getAttribute('href')?.startsWith('/')).toBe(true);
    }
  });

  it('the current page is marked with aria-current, not only a colour', async () => {
    render(<Sidebar />);
    await settle();
    const current = within(mainNav()).getByRole('link', { name: /dashboard/i });
    expect(current.getAttribute('aria-current')).toBe('page');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace login
// ─────────────────────────────────────────────────────────────────────────────

describe('8.2 — workspace login', () => {
  it('renders NO workspace field until the server demands one (D48 cont.)', async () => {
    render(<LoginPage />);
    await settle();
    // Positive control first — the real form rendered...
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    // ...and identifies the workspace from the email alone.
    expect(screen.queryByLabelText(/workspace/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/optional — leave blank/i);
  });

  it('honours a ?workspace= link silently — sent with the login, never shown', async () => {
    searchParams = new URLSearchParams('workspace=restaurant-demo');
    render(<LoginPage />);
    await settle();
    expect(screen.queryByLabelText(/workspace/i)).toBeNull();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();
    expect(loginWithEmail).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'restaurant-demo',
    );
  });

  it('omits the workspace entirely on a plain sign-in', async () => {
    render(<LoginPage />);
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();
    expect(loginWithEmail).toHaveBeenCalledWith(expect.any(String), expect.any(String), '');
  });

  it('reveals the workspace field on AUTH_WORKSPACE_REQUIRED, and sends what is typed', async () => {
    loginWithEmail.mockRejectedValueOnce(
      new ApiError(409, {
        statusCode: 409,
        code: 'AUTH_WORKSPACE_REQUIRED',
        message: 'Please enter your workspace to continue.',
        error: 'Conflict',
      }),
    );
    render(<LoginPage />);
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/more than one workspace/i);
    const field = screen.getByLabelText(/workspace/i);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // And it must not name any workspace — the API does not send one, and the UI
    // must not invent one.
    expect(alert.textContent).not.toMatch(/tile|cafe|restaurant-demo/i);

    // The revealed field is live: typing a slug routes it into the retry.
    type(field as HTMLInputElement, 'restaurant-demo');
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();
    expect(loginWithEmail).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'restaurant-demo',
    );
  });

  it('a generic failure does not claim a workspace is required', async () => {
    loginWithEmail.mockRejectedValueOnce(
      new ApiError(401, {
        statusCode: 401,
        message: 'Invalid email or password',
        error: 'Unauthorized',
      }),
    );
    render(<LoginPage />);
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/invalid email or password/i);
    // A generic failure must not reveal the workspace field either.
    expect(screen.queryByLabelText(/workspace/i)).toBeNull();
  });

  it('stores neither credentials nor workspace on the device (D48 cont.)', async () => {
    // The per-device workspace memory went with the visible field — a silently
    // replayed stale slug would fail a valid login with no visible cause.
    searchParams = new URLSearchParams('workspace=restaurant-demo');
    render(<LoginPage />);
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();

    const stored = JSON.stringify({ ...window.localStorage });
    expect(stored).not.toContain('restaurant-demo');
    expect(stored).not.toContain('password123');
    expect(stored.toLowerCase()).not.toContain('passw0rd');
  });

  it('offers no workspace directory or lookup, even when the field is revealed', async () => {
    loginWithEmail.mockRejectedValueOnce(
      new ApiError(409, {
        statusCode: 409,
        code: 'AUTH_WORKSPACE_REQUIRED',
        message: 'Please enter your workspace to continue.',
        error: 'Conflict',
      }),
    );
    render(<LoginPage />);
    await settle();
    screen.getByRole('button', { name: /^sign in$/i }).click();
    await settle();
    // A dropdown of workspaces would be a tenant directory readable by anyone.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((screen.getByLabelText(/workspace/i) as HTMLInputElement).list).toBeFalsy();
  });
});
