/**
 * D202 — the Products list asks before deactivating a product.
 *
 * The PO: "now we can deactivate product in menu can you add confirmation
 * popup". The Deactivate icon sits one button from Edit and, tapped, pulls
 * the item off the menu and the POS at every branch; it fired on a single
 * tap. It now asks through the app's own confirm (D145), and ONLY on the way
 * down — reactivation is the undo, and asking twice would make the correction
 * cost as much as the mistake.
 *
 * ## Why both directions, on the same row
 *
 * A confirm that fires but is not awaited walks straight through its guard
 * (the promise is truthy), and looks exactly like a cashier who tapped
 * Confirm. So Cancel is asserted to leave the endpoint UNCALLED, and Confirm
 * to call it — on the same fixture — and the reactivate case asserts no
 * dialog at all, so a confirm that became unconditional cannot pass.
 *
 * Mutation-proven, each against the page itself:
 *   1. the `await` dropped (`confirm({...})` unawaited) — "Cancel leaves it
 *      active" fails, 2 pass;
 *   2. the `p.isActive &&` guard dropped (asked in both directions) —
 *      "reactivates without asking" fails, 2 pass.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedProduct } from '@/lib/products-api';
import { Permission } from '@/lib/permissions';

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
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/products',
}));

const session = {
  token: 't',
  user: {
    id: 'u1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'OWNER' as const,
    tenantId: 'tnt_a',
    permissions: [Permission.PRODUCT_MANAGE] as Permission[],
  },
  branchId: 'b1',
  registerId: null,
  branchName: 'Main',
  registerName: '—',
};
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session,
    loading: false,
    isAuthenticated: true,
    hasPermission: (p: string) => session.user.permissions.includes(p as Permission),
  }),
}));
vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({ status: 'ready', inventoryMode: 'DISABLED', profile: null }),
}));

function product(over: Partial<ManagedProduct> = {}): ManagedProduct {
  return {
    id: 'prd_kottu',
    name: 'Chicken Kottu',
    type: 'Service',
    sku: null,
    description: null,
    categoryId: null,
    subcategoryId: null,
    unitPrice: 900,
    incomeAccount: null,
    purchaseDescription: null,
    costPrice: null,
    expenseAccount: null,
    quantityOnHand: 0,
    quantityAsOfDate: null,
    reorderLevel: null,
    inventoryAssetAccount: null,
    imageUrl: null,
    isActive: true,
    taxable: true,
    quantityType: 'WHOLE',
    unitOfMeasure: null,
    quickbooksItemId: null,
    syncStatus: 'NOT_SYNCED',
    lastSyncedAt: null,
    hasVariants: false,
    averageCost: null,
    attributes: {},
    sellableKind: 'COMPOSED_ITEM',
    soldOutAt: null,
    foodType: 'FOOD',
    ...over,
  } as ManagedProduct;
}

let rows: ManagedProduct[] = [];
const deactivateProduct = vi.fn();
const setProductActive = vi.fn();
vi.mock('@/lib/products-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products-api')>();
  return {
    ...actual,
    fetchProducts: () => Promise.resolve({ items: rows, total: rows.length, page: 1, pageSize: 20 }),
    fetchCategoryTree: () => Promise.resolve([]),
    deactivateProduct: (...a: unknown[]) => deactivateProduct(...a),
    setProductActive: (...a: unknown[]) => setProductActive(...a),
    resolveImageUrl: () => null,
  };
});
vi.mock('@/lib/products/brands-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/products/brands-api')>()),
  fetchBrands: () => Promise.resolve([]),
}));

const { ConfirmProvider } = await import('@/components/ui/confirm');
const ProductsPage = (await import('@/app/(app)/products/page')).default;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  render(
    <ConfirmProvider>
      <ProductsPage />
    </ConfirmProvider>,
  );
  await settle();
}

beforeEach(() => {
  rows = [product()];
  deactivateProduct.mockReset().mockResolvedValue(product({ isActive: false }));
  setProductActive.mockReset().mockResolvedValue(product());
});

afterEach(cleanup);

describe('deactivating a product asks first (D202)', () => {
  it('asks, naming the product — and Cancel leaves it active and the endpoint uncalled', async () => {
    // Proves the native dialog is gone as well as that the guard holds:
    // jsdom's `window.confirm` returns false, so a leftover call would ALSO
    // leave the row alone and this test would pass for the wrong reason.
    const native = vi.spyOn(window, 'confirm');
    await mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByRole('heading', { name: 'Deactivate Chicken Kottu?' })).toBeTruthy();
    expect(screen.getByText(/removed from the menu and the POS at every branch/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(deactivateProduct).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
    expect(native).not.toHaveBeenCalled();
  });

  it('deactivates once the question is answered', async () => {
    await mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    // The confirm button carries the verb, not "Confirm" — the heading is the
    // question and the button is the answer. Scoped to the dialog, because the
    // row's own icon button shares the name.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(deactivateProduct).toHaveBeenCalledWith(session, 'prd_kottu'));
  });

  it('reactivates without asking — the undo must not cost as much as the mistake', async () => {
    rows = [product({ isActive: false })];
    await mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(setProductActive).toHaveBeenCalledWith(session, 'prd_kottu', true));
    // NEGATIVE — no dialog was ever raised.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deactivateProduct).not.toHaveBeenCalled();
  });
});
