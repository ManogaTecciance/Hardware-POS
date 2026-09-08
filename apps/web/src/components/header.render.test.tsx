/**
 * The header's account menu, rendered.
 *
 * Two decisions meet here and neither had a test: D109 emptied the menu down
 * to the person's name and role, and fix/table-tab (merged in D110) made the
 * role line read the role ROW's name — "Waiter" — instead of the enum
 * underneath it, which for a waiter says CASHIER. Both are asserted
 * positively and negatively (D30): the lines that must be there, the lines
 * that must not, and the fallback for a session minted before `roleName`
 * existed.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Header, enumRoleLabel } from './header';

// ── boundaries ───────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

// The siblings in the header row each pull their own data; none of them is
// what this spec is about, and a stub keeps the DOM to the menu under test.
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/sync-status', () => ({ SyncStatus: () => null }));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/lib/sidebar', () => ({
  useSidebar: () => ({
    collapsed: false,
    toggleCollapsed: vi.fn(),
    mobileOpen: false,
    openMobile: vi.fn(),
    closeMobile: vi.fn(),
  }),
}));

interface SessionShape {
  user: { name: string; role: string; roleName?: string };
  branchName: string;
  registerName: string;
}
let session: SessionShape;
const logout = vi.fn();

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session, loading: false, isAuthenticated: true, logout, hasPermission: () => true }),
}));

// The session the seed's floor waiter carries: enum CASHIER, row "Waiter",
// and a branch and register that the menu used to print.
const WAITER: SessionShape = {
  user: { name: 'Nimal Perera', role: 'CASHIER', roleName: 'Waiter' },
  branchName: 'Main Dining',
  registerName: 'Counter 1',
};

function openMenu() {
  const button = screen.getByRole('button', { name: 'Account menu' });
  fireEvent.click(button);
  return screen.getByRole('menu');
}

afterEach(cleanup);

describe('the account menu (D109 + D110)', () => {
  it('names the person and the role ROW, both on the button and in the menu', () => {
    session = WAITER;
    render(<Header />);

    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(within(button).getByText('Nimal Perera')).toBeTruthy();
    expect(within(button).getByText('Waiter')).toBeTruthy();

    const menu = openMenu();
    expect(within(menu).getByText('Nimal Perera')).toBeTruthy();
    expect(within(menu).getByText('Waiter')).toBeTruthy();
    // The enum underneath is not what a person is shown — a waiter is not
    // told they are a cashier.
    expect(screen.queryByText(/cashier/i)).toBeNull();
  });

  it('shows neither the branch nor the register — anywhere in the header (D109)', () => {
    session = WAITER;
    render(<Header />);
    openMenu();
    // NEGATIVE, on the exact strings the session carries: the menu used to
    // print both under the role, and the session still holds them.
    expect(screen.queryByText('Main Dining')).toBeNull();
    expect(screen.queryByText('Counter 1')).toBeNull();
    // Positive control: the menu did open and did render the identity lines,
    // so the two absences above are not an empty menu.
    expect(within(screen.getByRole('menu')).getByText('Waiter')).toBeTruthy();
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /log out/i })).toBeTruthy();
  });

  it('falls back to the enum, spelt for a person, when the session predates roleName', () => {
    session = { ...WAITER, user: { name: 'Old Session', role: 'KITCHEN_STAFF' } };
    render(<Header />);
    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(within(button).getByText('Kitchen staff')).toBeTruthy();
    // NEGATIVE — not the raw enum, and not title-cased word by word.
    expect(screen.queryByText('KITCHEN_STAFF')).toBeNull();
    expect(screen.queryByText('Kitchen Staff')).toBeNull();
  });

  it('renders a role row name verbatim — it is not re-cased like the enum used to be', () => {
    session = { ...WAITER, user: { name: 'QB', role: 'ADMIN', roleName: 'QuickBooks admin' } };
    render(<Header />);
    expect(within(screen.getByRole('button', { name: 'Account menu' })).getByText('QuickBooks admin')).toBeTruthy();
    expect(screen.queryByText('Quickbooks Admin')).toBeNull();
  });

  it('logs out from the menu', () => {
    session = WAITER;
    render(<Header />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /log out/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe('enumRoleLabel', () => {
  it('spells every enum the way a person would say it', () => {
    expect(
      ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTANT', 'SALESPERSON', 'KITCHEN_STAFF'].map(enumRoleLabel),
    ).toEqual(['Owner', 'Admin', 'Manager', 'Cashier', 'Accountant', 'Salesperson', 'Kitchen staff']);
  });

  it('MUTATION PROOF — a title-casing helper would be detected', () => {
    const titleCase = (s: string) =>
      s
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    expect(titleCase('KITCHEN_STAFF')).toBe('Kitchen Staff');
    expect(() => expect(titleCase('KITCHEN_STAFF')).toBe(enumRoleLabel('KITCHEN_STAFF'))).toThrow();
  });
});
