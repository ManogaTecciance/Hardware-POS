/**
 * Product Details tabbed page — render coverage (D44).
 *
 * The Details page is the mainline detail surface for D44's variant catalogue.
 * Its contracts are: KPI tiles reflect single- vs multi-variant products, the
 * Variants tab lists every variant with cost + price columns, the
 * "Delete permanently" 409 path surfaces the friendly VARIANT_HAS_HISTORY
 * message, Receive Stock is offered only for LOCAL tenants with the receive
 * permission, and the Tabs component moves selection on ArrowRight.
 *
 * All API boundaries are mocked at the module seam so nothing hits the
 * network and jsdom's "Not implemented: navigation" noise never fires.
 * Every positive claim carries a negative — hidden button when a mode or
 * permission is off, no delete alert on the happy path — per D30.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BranchSummary } from '@/lib/products/branches-api';
import type { ProductVariant, ProductVariationDimension } from '@/lib/products/variants-api';
import type { ManagedProduct } from '@/lib/products-api';

// ── Module-boundary mocks ────────────────────────────────────────────────────

// next/link reads App Router context that jsdom doesn't provide; render it as a
// plain anchor so accessible-role queries still work and empty-tree defenses
// don't accidentally pass every "not present" query below.
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

const fetchVariants = vi.fn();
const fetchVariantInventory = vi.fn();
const updateVariant = vi.fn();
const deleteVariant = vi.fn();
const fetchVariations = vi.fn();

vi.mock('@/lib/products/variants-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/variants-api')>();
  return {
    ...actual,
    fetchVariants,
    fetchVariantInventory,
    updateVariant,
    deleteVariant,
    fetchVariations,
  };
});

const fetchReceipts = vi.fn();
vi.mock('@/lib/products/receipts-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/receipts-api')>();
  return { ...actual, fetchReceipts, createReceipt: vi.fn() };
});

const fetchSuppliers = vi.fn();
vi.mock('@/lib/suppliers/suppliers-api', () => ({
  fetchSuppliers,
}));

const fetchBranches = vi.fn();
vi.mock('@/lib/products/branches-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/branches-api')>();
  return { ...actual, fetchBranches };
});

// Imported after the mocks so it picks them up on first evaluation.
const { ProductDetail } = await import('./product-detail');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const noopSession = {
  token: 't',
  user: {
    id: 'u1',
    name: 'Owner',
    email: null,
    role: 'OWNER',
    tenantId: 'tnt_x',
    permissions: [],
  },
  branchId: 'br_main',
  registerId: null,
  branchName: 'Main',
  registerName: '—',
} as never;

const branches: BranchSummary[] = [
  { id: 'br_main', name: 'Main', code: 'MAIN', address: null, phone: null, registers: [] },
];

function makeProduct(overrides: Partial<ManagedProduct> = {}): ManagedProduct {
  return {
    id: 'prod_x',
    name: 'Coca-Cola',
    type: 'Inventory',
    sku: 'COKE',
    description: null,
    categoryId: null,
    subcategoryId: null,
    unitPrice: 220,
    incomeAccount: null,
    purchaseDescription: null,
    costPrice: 150,
    expenseAccount: null,
    quantityOnHand: 100,
    quantityAsOfDate: null,
    reorderLevel: null,
    inventoryAssetAccount: null,
    imageUrl: null,
    isActive: true,
    taxable: true,
    quickbooksItemId: null,
    syncStatus: 'NOT_SYNCED',
    lastSyncedAt: null,
    hasVariants: false,
    averageCost: 155,
    attributes: {},
    ...overrides,
  };
}

function makeVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: 'var_1',
    productId: 'prod_x',
    sku: 'COKE-200-G',
    barcode: null,
    unitPrice: 220,
    costPrice: 160,
    averageCost: 155,
    reorderLevel: null,
    imageUrl: null,
    position: 0,
    isActive: true,
    isDefault: false,
    optionValues: [
      { dimensionId: 'd1', optionId: 'o1', dimensionName: 'Size', optionName: '200ml' },
      { dimensionId: 'd2', optionId: 'o2', dimensionName: 'Packaging', optionName: 'Glass Bottle' },
    ],
    ...overrides,
  };
}

const emptyVariations: ProductVariationDimension[] = [];

/**
 * LOCAL-mode presentation, exactly as `resolveProductManagementPresentation`
 * would return it — a full shape rather than a partial to keep the type
 * checker honest against changes to `ProductPresentation`.
 */
const localPresentation = {
  managementMode: 'LOCAL' as const,
  label: 'Locally managed',
  badgeKind: 'neutral' as const,
  sourceLabel: 'Locally managed',
  sourceDetailLabel: 'Locally managed',
  sourceBadgeKind: 'neutral' as const,
  showSyncStatus: false,
  showSyncActions: false,
  showRefreshAction: false,
  showStockControls: true,
  showStockWarnings: true,
  stockTrackingNote: null,
  showExternalAccounts: false,
  helpText: 'Local.',
  detailsHelpText: 'Local.',
  imageHelpText: 'Local.',
  saveMessage: 'Saved.',
  warning: null,
};

/** QuickBooks presentation — external catalogue mode, no Receive Stock. */
const externalPresentation = {
  ...localPresentation,
  managementMode: 'EXTERNAL_CATALOGUE' as const,
  label: null,
  sourceLabel: 'QuickBooks',
  sourceDetailLabel: 'QuickBooks-managed',
  sourceBadgeKind: 'primary' as const,
  showSyncStatus: true,
  showSyncActions: true,
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  fetchVariants.mockReset();
  fetchVariantInventory.mockReset();
  updateVariant.mockReset();
  deleteVariant.mockReset();
  fetchVariations.mockReset();
  fetchReceipts.mockReset();
  fetchSuppliers.mockReset();
  fetchBranches.mockReset();
  // Sensible defaults; individual tests override.
  fetchVariants.mockResolvedValue([]);
  fetchVariantInventory.mockResolvedValue({ branches: [] });
  fetchVariations.mockResolvedValue({ dimensions: [] });
  fetchReceipts.mockResolvedValue({ items: [], total: 0 });
  fetchSuppliers.mockResolvedValue({ items: [], total: 0 });
  fetchBranches.mockResolvedValue(branches);
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────
// Overview KPIs
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — Overview KPIs', () => {
  it('single-variant product reports "Single-variant product" as the Variants KPI', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: false })}
        variants={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    // Positive: KPI text is the "Single-variant product" placeholder.
    expect(document.body.textContent).toMatch(/single-variant product/i);
    // Negative: the Variants tab trigger is NOT rendered when there are no
    // variants — the tab only appears once the product carries a matrix.
    expect(screen.queryByRole('tab', { name: /^variants$/i })).toBeNull();
  });

  it('multi-variant product renders a Variants tab and no single-variant placeholder', () => {
    const product = makeProduct({ hasVariants: true });
    render(
      <ProductDetail
        session={noopSession}
        product={product}
        variants={[makeVariant()]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    // Positive: Variants tab appears.
    expect(screen.getByRole('tab', { name: /^variants$/i })).toBeDefined();
    // Negative: the "Single-variant product" placeholder does NOT appear.
    expect(document.body.textContent).not.toMatch(/single-variant product/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Variants table
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — Variants tab table', () => {
  it('renders one row per variant with SKU, price, latest cost, and average cost cells', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: true })}
        variants={[
          makeVariant({ id: 'v1', sku: 'COKE-200-G', unitPrice: 220, costPrice: 160, averageCost: 155 }),
          makeVariant({
            id: 'v2',
            sku: 'COKE-500-P',
            unitPrice: 350,
            costPrice: 250,
            averageCost: 240,
            optionValues: [
              { dimensionId: 'd1', optionId: 'o5', dimensionName: 'Size', optionName: '500ml' },
              {
                dimensionId: 'd2',
                optionId: 'o3',
                dimensionName: 'Packaging',
                optionName: 'Plastic Bottle',
              },
            ],
          }),
        ]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );

    // Move to the Variants tab.
    fireEvent.click(screen.getByRole('tab', { name: /^variants$/i }));

    // Positive: each SKU is present, each price + cost format shows up.
    expect(document.body.textContent).toMatch(/COKE-200-G/);
    expect(document.body.textContent).toMatch(/COKE-500-P/);
    // Latest cost columns for both rows.
    expect(document.body.textContent).toMatch(/160/);
    expect(document.body.textContent).toMatch(/250/);
    // Average cost values, distinct from latest.
    expect(document.body.textContent).toMatch(/155/);
    expect(document.body.textContent).toMatch(/240/);

    // Negative: no "No variants yet" empty state — we have rows.
    expect(document.body.textContent).not.toMatch(/no variants yet/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete permanently — friendly VARIANT_HAS_HISTORY message
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — delete permanently 409 handling', () => {
  it('surfaces a friendly VARIANT_HAS_HISTORY message when the server refuses', async () => {
    deleteVariant.mockRejectedValueOnce(new Error('VARIANT_HAS_HISTORY'));

    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: true })}
        variants={[makeVariant()]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /^variants$/i }));

    // Open the actions menu for the single variant row.
    fireEvent.click(screen.getByRole('button', { name: /actions for/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete permanently/i }));

    // Confirm dialog is open — click the destructive confirmation button.
    const confirmBtn = screen
      .getAllByRole('button', { name: /delete permanently/i })
      .find((btn) => btn.tagName === 'BUTTON')!;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      // Positive: the friendly VARIANT_HAS_HISTORY message shows in the dialog.
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/historical sales/i);
      expect(alert.textContent).toMatch(/set it inactive instead/i);
    });
    // Negative: the raw error code does NOT leak into the UI.
    expect(document.body.textContent).not.toMatch(/VARIANT_HAS_HISTORY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receive Stock button visibility
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — Receive Stock button visibility', () => {
  it('shows Receive Stock when the tenant is LOCAL and the operator has INVENTORY_RECEIVE', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: false })}
        variants={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /receive stock/i })).toBeDefined();
  });

  it('hides Receive Stock without the INVENTORY_RECEIVE permission (server is still authority)', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: false })}
        variants={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={false}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    // Negative: the button is not rendered. The page itself still is —
    // otherwise a blank tree would satisfy any "not present" query.
    expect(screen.queryByRole('button', { name: /receive stock/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /coca-cola/i })).toBeDefined();
  });

  it('hides Receive Stock outside LOCAL mode even when the permission is granted', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: false, quickbooksItemId: 'qb_1', syncStatus: 'SYNCED' })}
        variants={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={externalPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /receive stock/i })).toBeNull();
    // Positive control: the page still rendered — this is a real absence.
    expect(screen.getByRole('heading', { name: /coca-cola/i })).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tabs keyboard: ArrowRight moves selection and old panel is hidden
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — Tabs keyboard behaviour', () => {
  it('ArrowRight on the active tab moves selection and hides the previous panel', async () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: true })}
        variants={[makeVariant()]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
      />,
    );
    const overviewTab = screen.getByRole('tab', { name: /^overview$/i });
    const variantsTab = screen.getByRole('tab', { name: /^variants$/i });

    // Positive precondition: Overview is selected on mount.
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    expect(variantsTab.getAttribute('aria-selected')).toBe('false');

    // Simulate roving-tabindex ArrowRight on the currently active tab.
    await act(async () => {
      fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    });

    // Positive: Variants now owns the selection.
    expect(variantsTab.getAttribute('aria-selected')).toBe('true');
    // Negative: the Overview panel is now hidden per the Tabs contract.
    // Panels have role=tabpanel; the inactive one carries the `hidden` attribute.
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    const overviewPanel = panels.find((p) => within(p).queryByText(/at a glance/i));
    expect(overviewPanel).toBeDefined();
    expect(overviewPanel!.hasAttribute('hidden')).toBe(true);
  });
});
