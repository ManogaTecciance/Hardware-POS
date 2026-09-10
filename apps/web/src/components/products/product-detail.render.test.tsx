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
import type { AttributeField } from '@hardware-pos/shared';
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

/**
 * D158 — a catalogue that ANSWERED and is empty, which is not the same as one
 * that has not answered. The fixtures above carry no `categoryId` and no
 * `brandId`, so these are never actually consulted; the D158 cases below pass
 * their own. Naming it here keeps that distinction visible rather than letting
 * `{state:'ready', rows:[]}` read as "no catalogue" at thirteen call sites.
 */
const answeredEmpty = { state: 'ready' as const, rows: [] };

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
    // D134 (`6.1`) — these fixtures stand for ordinary counted stock.
    quantityType: 'WHOLE',
    unitOfMeasure: null,
    quickbooksItemId: null,
    syncStatus: 'NOT_SYNCED',
    lastSyncedAt: null,
    hasVariants: false,
    averageCost: 155,
    attributes: {},
    // D101 — a plain tracked retail row; dish cases override these.
    sellableKind: 'STOCK_ITEM',
    soldOutAt: null,
    foodType: null,
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={false}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={externalPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
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

// ─────────────────────────────────────────────────────────────────────────────
// D103 — stock tabs follow the item's stock presentation
// ─────────────────────────────────────────────────────────────────────────────

describe('ProductDetail — Inventory/Purchases tabs (D101/D103)', () => {
  it('a dish offers neither Inventory nor Purchases — counts mean nothing for it', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ sellableKind: 'COMPOSED_ITEM', foodType: 'FOOD' })}
        variants={[]}
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );
    expect(screen.queryByRole('tab', { name: /^inventory$/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^purchases$/i })).toBeNull();
    // Positive control: the tab strip itself is alive — Overview and
    // History still render, so the negatives are not a missing TabsList.
    expect(screen.getByRole('tab', { name: /^overview$/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /^history$/i })).toBeDefined();
  });

  it('a tracked stock item keeps both tabs — the gate is the kind, not a removal', () => {
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct()}
        variants={[]}
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );
    expect(screen.getByRole('tab', { name: /^inventory$/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /^purchases$/i })).toBeDefined();
  });
});

/**
 * D156 — the overview must not assert a shape it has not been told.
 *
 * ## The defect
 *
 * `variants` arrives in a second fetch that deliberately does not gate the
 * page's loading state, so it is `[]` on first paint. The overview read that
 * empty array as fact and announced "Single-variant product" for a 25-variant
 * product, beside the parent's `unitPrice` — Rs 0.00 on every product created
 * since D44, because D44 says that field is not read once `hasVariants` is
 * true. It corrected itself a beat later, so it read as a flicker; on a failed
 * request it never corrected, because the catch turned the error into `[]`.
 *
 * ## What makes these assertions non-vacuous
 *
 * The three states are asserted against the SAME product — one with
 * `hasVariants: true` — so a component that had simply stopped rendering the
 * KPI would fail all three rather than passing whichever was checked alone.
 * Each case also pins what must NOT appear: the wrong claim is the defect, and
 * "loading" quietly replacing every KPI would be its own regression.
 */
describe('D156 — the Variants KPI while the list is still loading', () => {
  const mount = (variantsState: 'loading' | 'ready' | 'error', variants = [makeVariant()]) =>
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: true })}
        variants={variantsState === 'ready' ? variants : []}
        variantsState={variantsState}
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );

  it('says it is loading, and does NOT claim the product is single-variant', () => {
    mount('loading');

    // The defect, stated as an assertion: this product has 25 variants in the
    // database, and the page must not say otherwise while it is still asking.
    expect(document.body.textContent).not.toMatch(/single-variant product/i);
    expect(document.body.textContent).toMatch(/loading/i);
  });

  it('does not show the parent’s legacy price while the range is unknown', () => {
    /*
     * D44 — `product.unitPrice` is a legacy fallback on a variant product, and
     * every product created since D44 carries 0. Showing it during the wait is
     * not a placeholder, it is a wrong number.
     *
     * The fixture's default price is 220, which would make an
     * `expect(...).not.toMatch(/Rs 0.00/)` assertion pass no matter what the
     * component did. So this builds the real shape — a variant product whose
     * parent price is the legacy 0 — which is what the reported screenshot
     * showed.
     */
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: true, unitPrice: 0 })}
        variants={[]}
        variantsState="loading"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );
    expect(document.body.textContent).not.toMatch(/Rs\.?\s*0\.00/);
  });

  it('reports the count once the list lands', () => {
    mount('ready');

    expect(document.body.textContent).toMatch(/1 active/i);
    expect(document.body.textContent).not.toMatch(/single-variant product/i);
    // …and the wait wording is gone, so "loading" is not simply always on.
    expect(document.body.textContent).not.toMatch(/loading…/i);
  });

  it('says so when the list could not be loaded, instead of inventing a shape', () => {
    /*
     * The half that was invisible before: the fetch caught its own error and
     * returned `[]`, so a failure looked exactly like a single-variant product
     * and never resolved. Silence here is worse than an error — the operator
     * reads a confident, wrong answer.
     */
    mount('error');

    expect(document.body.textContent).toMatch(/could not be loaded/i);
    expect(document.body.textContent).not.toMatch(/single-variant product/i);
  });

  it('a genuinely single-variant product still answers immediately', () => {
    /*
     * The control. `product.hasVariants` is authoritative and arrives WITH the
     * product, so a single-variant product must not wait on a list it has no
     * reason to care about — otherwise the fix would have traded a wrong answer
     * for a slow one on every simple product in the catalogue.
     */
    render(
      <ProductDetail
        session={noopSession}
        product={makeProduct({ hasVariants: false })}
        variants={[]}
        variantsState="loading"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );

    expect(document.body.textContent).toMatch(/single-variant product/i);
    expect(document.body.textContent).not.toMatch(/loading…/i);
  });
});

/**
 * D158 — the Overview shows what the product IS, not only what it costs.
 *
 * ## What was reported
 *
 * "its not rendering the data and some data are missing from it like category,
 * brand, if have business details it needed to show too, variations etc are
 * missing too". All four were on hand: `categoryId`, `brandId` and
 * `attributes` ride on the product payload, and the variation dimensions were
 * already being fetched — and then used only to populate an edit dialog.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Two traps, and a case for each.
 *
 * The first is the D156 trap one card over: a name that has not arrived yet
 * must not render as `—`, because `—` is what a product with NO category
 * shows. Both are asserted against products that differ only in whether the id
 * is set, so an implementation that treated "waiting" and "absent" alike fails
 * one of the pair whichever way it collapsed them.
 *
 * The second is the empty card. Business details and Variations are absent for
 * most products — hardware's vertical declares no attributes at all — so a
 * test that only checked "the card appears when there is data" would pass an
 * implementation that rendered an empty card on every single product. Every
 * absence case therefore also asserts a heading that MUST still be present, so
 * it cannot pass because the Overview rendered nothing.
 */
describe('D158 — Category and Brand', () => {
  const mount = (
    product: ManagedProduct,
    over: {
      categories?: { state: 'loading' | 'ready' | 'error'; rows: never[] | unknown[] };
      brands?: { state: 'loading' | 'ready' | 'error'; rows: never[] | unknown[] };
    } = {},
  ) =>
    render(
      <ProductDetail
        session={noopSession}
        product={product}
        variants={[]}
        variantsState="ready"
        variationsState="ready"
        categories={(over.categories ?? answeredEmpty) as never}
        brands={(over.brands ?? answeredEmpty) as never}
        attributeFields={[]}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );

  const category = {
    id: 'cat_1',
    name: 'Building Materials',
    subcategories: [{ id: 'sub_1', categoryId: 'cat_1', name: 'Cement' }],
  };

  it('names the category and its subcategory', async () => {
    mount(makeProduct({ categoryId: 'cat_1', subcategoryId: 'sub_1' }), {
      categories: { state: 'ready', rows: [category] },
    });

    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    expect(document.body.textContent).toContain('Building Materials › Cement');
  });

  it('waits for the name instead of claiming the product has none', async () => {
    mount(makeProduct({ categoryId: 'cat_1', subcategoryId: null }), {
      categories: { state: 'loading', rows: [] },
    });

    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    const row = screen.getByText('Category').parentElement;
    expect(row?.textContent).toContain('Loading');
    // The D156 trap, stated as an assertion: `—` here would be
    // indistinguishable from the uncategorised product in the next case.
    expect(row?.textContent).not.toContain('—');
  });

  it('says "—" at once for a product that has no category', async () => {
    // The paired half. Same catalogue state as a fresh page load, and the
    // answer is instant because `categoryId` arrives WITH the product.
    mount(makeProduct({ categoryId: null }), { categories: { state: 'loading', rows: [] } });

    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    const row = screen.getByText('Category').parentElement;
    expect(row?.textContent).toContain('—');
    expect(row?.textContent).not.toContain('Loading');
  });

  it('shows no Brand row at all when the product carries no brand', async () => {
    mount(makeProduct());

    // NEGATIVE — D133 says most hardware and grocery products have no brand
    // worth recording, so a permanent empty row is one every operator on those
    // verticals reads past forever.
    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    expect(screen.queryByText('Brand')).toBeNull();
    // POSITIVE — and the card itself is there, so this cannot pass because
    // the Overview failed to render.
    expect(screen.getByText('SKU')).toBeTruthy();
  });

  it('shows the brand when the product has one', async () => {
    mount(makeProduct({ brandId: 'brd_1' }), {
      brands: { state: 'ready', rows: [{ id: 'brd_1', name: 'Tokyo Cement', isActive: true, productCount: 2 }] },
    });

    await waitFor(() => expect(screen.getByText('Brand')).toBeTruthy());
    expect(screen.getByText('Brand').parentElement?.textContent).toContain('Tokyo Cement');
  });
});

describe('D158 — Business details', () => {
  const mount = (product: ManagedProduct, fields: AttributeField[]) =>
    render(
      <ProductDetail
        session={noopSession}
        product={product}
        variants={[]}
        variantsState="ready"
        variationsState="ready"
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={fields}
        variations={emptyVariations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );

  const fields: AttributeField[] = [
    { key: 'material', label: 'Material', type: 'text' },
    { key: 'weatherproof', label: 'Weatherproof', type: 'boolean' },
  ];

  it("renders the tenant's labels against the product's values", async () => {
    mount(makeProduct({ attributes: { material: 'Galvanised steel', weatherproof: false } }), fields);

    await waitFor(() => expect(screen.getByText('Business details')).toBeTruthy());
    expect(screen.getByText('Material').parentElement?.textContent).toContain('Galvanised steel');
    // `false` is a fact a customer asks about, and the one value that vanishes
    // from JSX and from every truthiness filter.
    expect(screen.getByText('Weatherproof').parentElement?.textContent).toContain('No');
  });

  it('renders no card for a product with nothing recorded', async () => {
    mount(makeProduct({ attributes: {} }), fields);

    await waitFor(() => expect(screen.getByText('At a glance')).toBeTruthy());
    // NEGATIVE — an empty card on every product would be worse than the
    // missing section that was reported.
    expect(screen.queryByText('Business details')).toBeNull();
  });

  it('renders no card for a vertical that declares no attributes', async () => {
    // Hardware: `GET /products/attribute-schema` answers `{fields: []}`,
    // verified live. The card must not appear for them at all.
    mount(makeProduct({ attributes: {} }), []);

    await waitFor(() => expect(screen.getByText('At a glance')).toBeTruthy());
    expect(screen.queryByText('Business details')).toBeNull();
  });
});

describe('D158 — Variations', () => {
  const dimensions: ProductVariationDimension[] = [
    {
      id: 'dim_1',
      name: 'Size',
      position: 0,
      attributeDefinitionId: null,
      options: [
        { id: 'opt_s', name: 'Small', position: 0, attributeOptionId: null },
        { id: 'opt_m', name: 'Medium', position: 1, attributeOptionId: null },
      ],
    },
  ];

  const mount = (
    product: ManagedProduct,
    variations: ProductVariationDimension[],
    variationsState: 'loading' | 'ready' | 'error' = 'ready',
  ) =>
    render(
      <ProductDetail
        session={noopSession}
        product={product}
        variants={[makeVariant()]}
        variantsState="ready"
        variationsState={variationsState}
        categories={answeredEmpty}
        brands={answeredEmpty}
        attributeFields={[]}
        variations={variations}
        branches={branches}
        presentation={localPresentation}
        hasReceivePermission={true}
        hasManagePermission={true}
        canSyncQb={false}
        syncBusy={false}
        onSync={() => {}}
        onReload={() => {}}
        canSetAvailability={false}
      />,
    );

  it('lists each dimension with the options it offers', async () => {
    mount(makeProduct({ hasVariants: true }), dimensions);

    await waitFor(() => expect(screen.getByText('Variations')).toBeTruthy());
    const card = screen.getByText('Variations').closest('div')?.parentElement;
    expect(card?.textContent).toContain('Size');
    expect(card?.textContent).toContain('Small');
    expect(card?.textContent).toContain('Medium');
  });

  it('renders no card for a single-variant product', async () => {
    mount(makeProduct({ hasVariants: false }), []);

    await waitFor(() => expect(screen.getByText('At a glance')).toBeTruthy());
    expect(screen.queryByText('Variations')).toBeNull();
  });

  it('says so when the dimensions could not be loaded', async () => {
    /*
     * D156 left this fetch's failure flattened to `[]` and said why: nothing
     * displayed it. It does now, so an empty list from a failed request would
     * read as "this product varies on nothing" — for a product whose own
     * payload says it has variants.
     */
    mount(makeProduct({ hasVariants: true }), [], 'error');

    await waitFor(() => expect(screen.getByText('Variations')).toBeTruthy());
    expect(document.body.textContent).toContain('Could not be loaded');
  });
});
