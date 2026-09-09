/**
 * A saved promotion can be looked at.
 *
 * ## What was wrong
 *
 * There was no `/products/promotions/[id]`. Saving pushed the operator back to
 * the list, which shows a name, a type badge, a schedule summary and a product
 * COUNT — so the items, the money, the branch/channel scope and the stacking
 * rule they had just configured were unverifiable. Every "view" affordance
 * (the list's name link, the row's View link) pointed at `/edit`, and the edit
 * route refuses a PRODUCT_READ operator outright: "View" led to a permission
 * notice. `GET /promotions/:id` has only ever required PRODUCT_READ.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The permission case asserts, in one render, both what a read-only operator
 * MUST see (the promotion's own facts) and what they must NOT (Edit, Delete,
 * Deactivate). Either half alone would pass for a blank page — the positive
 * half alone would pass for a page that offers a read-only user the manage
 * buttons, and the negative half alone for a page that renders nothing at all.
 *
 * The redirect spec asserts the exact route saving lands on, not merely that
 * `push` was called: pushing back to the list is the bug, and it is also a
 * call to `push`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

import { Permission } from '@/lib/permissions';
import type { Promotion } from '@/lib/products/promotions-api';

// ── boundaries ───────────────────────────────────────────────────────────────

const push = vi.fn();
const replace = vi.fn();

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ id: 'promo-1' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/products/promotions/promo-1',
}));

const session = {
  token: 't',
  refreshToken: 'r',
  user: {
    id: 'u1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'OWNER' as const,
    tenantId: 'tnt_a',
    permissions: [] as Permission[],
  },
  branchId: 'brn_1',
  registerId: null,
  branchName: 'Main',
  registerName: '—',
};

/** Flipped per test so one suite covers a manager and a read-only operator. */
let permissions: Permission[] = [Permission.PRODUCT_READ, Permission.PRODUCT_MANAGE];

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session,
    loading: false,
    isAuthenticated: true,
    hasPermission: (p: string) => permissions.includes(p as Permission),
    loginWithEmail: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor('RETAIL').capabilities },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

/** A bundle with everything the list could not show. */
const bundle: Promotion = {
  id: 'promo-1',
  tenantId: 'tnt_a',
  name: 'Lunch Bundle',
  description: 'Rice, curry and a drink',
  type: 'BUNDLE_FIXED_PRICE',
  fixedPrice: 1500,
  percentageOff: null,
  amountOff: null,
  minimumSpend: null,
  buyQuantity: null,
  getQuantity: null,
  startsOn: '2026-09-01',
  endsOn: null,
  daysOfWeek: ['MON', 'TUE'],
  startTime: '11:00',
  endTime: '15:00',
  branchScope: ['brn_1'],
  channelScope: ['COUNTER'],
  stackable: false,
  isActive: true,
  createdAt: '2026-09-01T04:30:00.000Z',
  updatedAt: '2026-09-02T04:30:00.000Z',
  items: [
    { id: 'pi-1', productId: 'prod-1', productName: 'Rice & Curry', role: 'BUNDLE', quantity: 1 },
    { id: 'pi-2', productId: 'prod-2', productName: 'Iced Coffee', role: 'BUNDLE', quantity: 1 },
  ],
};

/** Mutated per test so one fixture covers the schedule-notice case too. */
let promotion: Promotion = bundle;

const fetchPromotion = vi.fn(async () => promotion);
const deletePromotion = vi.fn(async () => ({ id: 'promo-1' }));
const deactivatePromotion = vi.fn(async () => ({ ...promotion, isActive: false }));
const createPromotion = vi.fn(async () => ({ ...bundle, id: 'promo-created' }));

vi.mock('@/lib/products/promotions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/promotions-api')>();
  return {
    ...actual,
    fetchPromotion,
    deletePromotion,
    deactivatePromotion,
    activatePromotion: vi.fn(async () => promotion),
    createPromotion,
    updatePromotion: vi.fn(async () => promotion),
  };
});

vi.mock('@/lib/products/branches-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/branches-api')>();
  return {
    ...actual,
    fetchBranches: vi.fn(async () => [
      { id: 'brn_1', name: 'Kandy Road', code: 'KDY', address: null, phone: null, registers: [] },
    ]),
  };
});

// The editor's own product picker seam — unrelated to what these specs assert,
// but left live it issues a request under jsdom and buries the real failure.
vi.mock('@/lib/products-api', () => ({
  listManagedProducts: async () => ({ items: [], total: 0, nextCursor: null }),
  resolveImageUrl: (u: string | null) => u,
}));

// Imported after the mocks so the modules under test pick them up.
const PromotionDetailPage = (await import('@/app/(app)/products/promotions/[id]/page')).default;
const { PromotionEditor } = await import('./promotion-editor');

// ── helpers ──────────────────────────────────────────────────────────────────

async function renderDetail() {
  render(<PromotionDetailPage />);
  await screen.findByRole('heading', { name: 'Lunch Bundle' });
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = [Permission.PRODUCT_READ, Permission.PRODUCT_MANAGE];
  promotion = bundle;
});

afterEach(cleanup);

// ── specs ────────────────────────────────────────────────────────────────────

describe('promotion detail', () => {
  it('shows the facts the list could not: money, items, scope and stacking', async () => {
    await renderDetail();

    // The bundle price — a number the list never rendered at all.
    expect(screen.getByText(/1,500\.00/)).toBeTruthy();

    // Both linked products, by name and role, not as a count of 2.
    expect(screen.getByRole('link', { name: 'Rice & Curry' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Iced Coffee' })).toBeTruthy();
    expect(screen.getAllByText('In bundle')).toHaveLength(2);

    // Branch scope resolved to a name. A raw `brn_1` is the 4.10 bug again:
    // an operator cannot recognise their own branch from an id.
    expect(screen.getByText('Kandy Road')).toBeTruthy();
    expect(screen.queryByText('brn_1')).toBeNull();

    expect(screen.getByText('Counter')).toBeTruthy();
    expect(screen.getByText('Cannot combine with other promotions')).toBeTruthy();
    expect(screen.getByText('Mon, Tue')).toBeTruthy();
    expect(screen.getByText('11:00–15:00')).toBeTruthy();
  });

  it('reads an empty scope as everywhere, not nowhere', async () => {
    promotion = { ...bundle, branchScope: [], channelScope: [] };
    await renderDetail();

    // The evaluator treats an empty scope as unrestricted, so a blank row here
    // would tell the operator the opposite of what the promotion does.
    expect(screen.getByText('All branches')).toBeTruthy();
    expect(screen.getByText('All channels')).toBeTruthy();
  });

  it('warns that an inverted window can never fire, even while Active', async () => {
    promotion = { ...bundle, startTime: '15:00', endTime: '11:00' };
    await renderDetail();

    // This is the screen an operator opens to find out why an offer is not
    // applying; "Active" alone would be the more misleading of the two views.
    expect(screen.getByText('Active')).toBeTruthy();
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /Never fires/.test(a.textContent ?? ''))).toBe(true);
  });

  it('lets a manager delete, and returns to the list once the record is gone', async () => {
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deletePromotion).toHaveBeenCalledWith(session, 'promo-1'));
    // replace, not push: there is nothing left to come back to.
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/promotions'));
  });

  it('gives a PRODUCT_READ operator the details and none of the manage actions', async () => {
    permissions = [Permission.PRODUCT_READ];
    await renderDetail();

    // POSITIVE — the whole point of the screen: this operator can now read the
    // promotion, where /edit answered them with a permission notice.
    expect(screen.getByText(/1,500\.00/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Rice & Curry' })).toBeTruthy();

    // NEGATIVE — and is offered no action the server would refuse.
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Deactivate/ })).toBeNull();
  });
});

describe('after saving', () => {
  it('lands on the saved promotion, not back on the list', async () => {
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toBeTruthy());

    // Amount off is the one type that needs no items, so this drives a real
    // save through the real validator without a product picker round trip.
    // The type buttons carry an icon inside them ("LKR" here), so the
    // accessible name is not the bare label.
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rs 200 off' } });
    fireEvent.change(screen.getByLabelText(/^Amount off/), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));
    // The id comes from the response, so a create lands on the record that was
    // actually written rather than on a route guessed from the form.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/products/promotions/promo-created'));
    expect(push).not.toHaveBeenCalledWith('/products/promotions');
  });
});
