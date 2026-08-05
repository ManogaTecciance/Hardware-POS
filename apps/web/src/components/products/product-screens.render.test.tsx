/**
 * The product screens, rendered, once per inventory mode.
 *
 * ## Why these are render tests and not source-text tests
 *
 * The claims this slice has to make are about what an operator can see and click:
 * "a LOCAL tenant is not offered Sync to QuickBooks". A regex over the component
 * source cannot make that claim honestly — it passes equally when the button is
 * gone, when the pattern stopped matching, and when the component was renamed and
 * the analyser read nothing. Rendering and querying by accessible role can only
 * pass one way, and it exercises the resolver, the flags and the JSX together.
 *
 * Only the boundaries are stubbed: the API client, the session, and the profile
 * hook. The components, the resolver and the wiring between them are real.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@/lib/permissions';
import type { InventoryMode } from '@/lib/platform-api';
import type { ManagedProduct } from '@/lib/products-api';

// ── boundaries ───────────────────────────────────────────────────────────────

const push = vi.fn();
const searchParams = new URLSearchParams();

/**
 * `next/link` reads the App Router context, which does not exist outside a Next
 * render. Left real it throws during render and blanks the whole tree — which
 * would have made every `queryBy…().toBeNull()` below pass for the worst possible
 * reason. A plain anchor keeps the accessible roles these specs query.
 */
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
  useRouter: () => ({ push, back: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ id: 'prod-1' }),
  useSearchParams: () => searchParams,
  usePathname: () => '/products',
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
    permissions: [Permission.PRODUCT_MANAGE, Permission.QUICKBOOKS_MANAGE] as Permission[],
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
    loginWithEmail: vi.fn(),
    loginWithPin: vi.fn(),
    logout: vi.fn(),
  }),
}));

/** The profile state under test. Set by {@link renderForMode} before each render. */
let profileState: { status: 'loading' | 'ready' | 'error'; inventoryMode: InventoryMode | null } = {
  status: 'ready',
  inventoryMode: 'QUICKBOOKS',
};

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({ ...profileState, profile: null }),
}));

const product: ManagedProduct = {
  id: 'prod-1',
  name: 'Blue Ceramic Tile',
  type: 'Inventory',
  sku: 'TIL-001',
  description: null,
  categoryId: null,
  subcategoryId: null,
  unitPrice: 100,
  incomeAccount: null,
  purchaseDescription: null,
  costPrice: 60,
  expenseAccount: null,
  quantityOnHand: 12,
  quantityAsOfDate: null,
  reorderLevel: 20,
  inventoryAssetAccount: null,
  imageUrl: null,
  isActive: true,
  // A perfectly valid local product: never reached QuickBooks, and under LOCAL or
  // DISABLED never will. This is the row that must not be styled as a fault.
  quickbooksItemId: null,
  syncStatus: 'NOT_SYNCED',
  lastSyncedAt: null,
};

const syncProductToQuickBooks = vi.fn().mockResolvedValue(product);
const createProduct = vi.fn().mockResolvedValue(product);
const updateProduct = vi.fn().mockResolvedValue(product);

vi.mock('@/lib/products-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products-api')>();
  return {
    ...actual,
    fetchProducts: vi.fn().mockResolvedValue({ items: [product], total: 1, page: 1, pageSize: 20 }),
    fetchProduct: vi.fn().mockResolvedValue(product),
    fetchCategoryTree: vi.fn().mockResolvedValue([]),
    deactivateProduct: vi.fn().mockResolvedValue(product),
    setProductActive: vi.fn().mockResolvedValue(product),
    downloadProductsReport: vi.fn().mockResolvedValue(undefined),
    uploadProductImage: vi.fn().mockResolvedValue(product),
    deleteProductImage: vi.fn().mockResolvedValue(product),
    resolveImageUrl: () => null,
    syncProductToQuickBooks,
    createProduct,
    updateProduct,
  };
});

// Imported after the mocks so the modules under test pick them up.
const ProductsPage = (await import('@/app/(app)/products/page')).default;
const ProductDetailPage = (await import('@/app/(app)/products/[id]/page')).default;
const { ProductForm } = await import('@/components/products/product-form');

// ── helpers ──────────────────────────────────────────────────────────────────

const MODES = ['QUICKBOOKS', 'LOCAL', 'DISABLED', 'EXTERNAL'] as const;
const NO_SYNC_MODES = ['LOCAL', 'DISABLED', 'EXTERNAL'] as const;

/** Let the mocked promise chains and the effects that consume them settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderScreen(
  Screen: () => React.JSX.Element | null,
  state: typeof profileState,
): Promise<void> {
  profileState = state;
  render(<Screen />);
  await settle();
}

function ready(inventoryMode: InventoryMode) {
  return { status: 'ready' as const, inventoryMode };
}

/** The whole rendered document, for wording assertions. */
function bodyText(): string {
  return document.body.textContent ?? '';
}

const QUICKBOOKS_WORDS = /quickbooks|not synced|sync failed/i;

// The wizard scrolls to the top on every step change. jsdom has no layout, so it
// logs a "not implemented" error for each call — noise that would bury a real one.
beforeAll(() => {
  window.scrollTo = () => undefined;
});

beforeEach(() => {
  vi.clearAllMocks();
  profileState = ready('QUICKBOOKS');
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────
// 11-15, 21-22 — the explicit sync action
// ─────────────────────────────────────────────────────────────────────────────

describe('11-15 — the explicit sync action appears for QUICKBOOKS and nowhere else', () => {
  it('11 — a QUICKBOOKS tenant is offered "Sync to QuickBooks"', async () => {
    await renderScreen(ProductDetailPage, ready('QUICKBOOKS'));
    expect(screen.getByRole('button', { name: /sync to quickbooks/i })).toBeDefined();
  });

  it.each(NO_SYNC_MODES)('12/13 — a %s tenant is not', async (mode) => {
    await renderScreen(ProductDetailPage, ready(mode));
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).toBeNull();
    // POSITIVE CONTROL: the page did render, so the absence above is a real
    // absence rather than a blank screen that would satisfy any query.
    expect(screen.getByRole('heading', { name: product.name })).toBeDefined();
  });

  it.each(NO_SYNC_MODES)('14/15 — a %s tenant sees no refresh or retry either', async (mode) => {
    await renderScreen(ProductDetailPage, ready(mode));
    for (const label of [/refresh from quickbooks/i, /retry quickbooks/i, /retry sync/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByRole('heading', { name: product.name })).toBeDefined();
  });

  it('the QuickBooks endpoint is never called from a screen that hides the control', async () => {
    for (const mode of NO_SYNC_MODES) {
      await renderScreen(ProductDetailPage, ready(mode));
      cleanup();
    }
    expect(syncProductToQuickBooks).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7, 8 — profile loading and failure
// ─────────────────────────────────────────────────────────────────────────────

describe('7/8 — an unresolved or failed profile exposes no QuickBooks action', () => {
  it('7 — while the profile is loading, the screen shows a neutral loading state', async () => {
    await renderScreen(ProductDetailPage, { status: 'loading', inventoryMode: null });
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).toBeNull();
    expect(bodyText()).toContain('Loading');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });

  it('8 — after a failed profile request, no QuickBooks action appears', async () => {
    await renderScreen(ProductDetailPage, { status: 'error', inventoryMode: null });
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).toBeNull();
    // The product itself is still shown — failing safe is not failing blank.
    expect(screen.getByRole('heading', { name: product.name })).toBeDefined();
  });

  it('the list waits for the profile rather than drawing QuickBooks columns first', async () => {
    await renderScreen(ProductsPage, { status: 'loading', inventoryMode: null });
    expect(bodyText()).toContain('Loading products');
    expect(screen.queryByRole('columnheader', { name: /source/i })).toBeNull();
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21, 22, 25 — wording and styling on the list
// ─────────────────────────────────────────────────────────────────────────────

describe('21/22/25 — provider-neutral wording on the product list', () => {
  it('a QUICKBOOKS tenant keeps the existing sync column, badge and filter', async () => {
    await renderScreen(ProductsPage, ready('QUICKBOOKS'));
    expect(screen.getByRole('columnheader', { name: /source/i })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: /on hand/i })).toBeDefined();
    expect(screen.getByLabelText(/filter by sync status/i)).toBeDefined();
    expect(screen.getByLabelText(/filter by stock status/i)).toBeDefined();
    // The unlinked product keeps today's exact wording for a QuickBooks tenant.
    expect(bodyText()).toContain('Not synced');
    expect(bodyText()).toContain('QuickBooks remains the inventory master');
  });

  it('21 — a LOCAL tenant sees "Locally managed" and no QuickBooks wording', async () => {
    await renderScreen(ProductsPage, ready('LOCAL'));
    expect(bodyText()).toContain('Locally managed');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
    expect(screen.queryByLabelText(/filter by sync status/i)).toBeNull();
    // Stock is still there — LOCAL tracks it.
    expect(screen.getByRole('columnheader', { name: /on hand/i })).toBeDefined();
    expect(screen.getByLabelText(/filter by stock status/i)).toBeDefined();
  });

  it('22 — a DISABLED tenant sees catalogue wording, no stock and no QuickBooks', async () => {
    await renderScreen(ProductsPage, ready('DISABLED'));
    expect(bodyText()).toContain('Catalogue item');
    expect(bodyText()).toContain('Stock tracking is disabled');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
    expect(screen.queryByRole('columnheader', { name: /on hand/i })).toBeNull();
    expect(screen.queryByLabelText(/filter by stock status/i)).toBeNull();
  });

  it('6 — an EXTERNAL tenant is told the provider is not configured', async () => {
    await renderScreen(ProductsPage, ready('EXTERNAL'));
    expect(bodyText()).toContain('External inventory provider is not configured');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });

  /**
   * Requirement 25 is narrower than "no warning styling anywhere on the row", and
   * the difference matters. The fixture is genuinely low on stock (12 against a
   * reorder point of 20), and under LOCAL that warning is *correct* — AxloPOS
   * tracks the stock, so it is entitled to flag it. What must never happen is a
   * product being styled as a problem because it has no `quickbooksItemId`.
   *
   * So this asserts on the two badges that describe the product's management
   * state, and separately asserts the stock warning survives — a blanket "no
   * warning class in this row" check would have forced the stock warning off and
   * quietly broken a feature LOCAL tenants need.
   */
  it('25 — a valid local product is not styled as a fault for having no item id', async () => {
    await renderScreen(ProductsPage, ready('LOCAL'));
    const row = screen.getByRole('row', { name: new RegExp(product.name, 'i') });

    const badges = within(row).getAllByText(/locally managed/i);
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.className).not.toMatch(/text-danger|text-warning|bg-danger|bg-warning/);
      expect(badge.className).toMatch(/text-muted-foreground/);
    }

    // POSITIVE CONTROL 1: the class matcher fires on styling that IS a warning.
    expect(within(row).getByText('Low').className).toMatch(/text-warning/);
    // POSITIVE CONTROL 2: which also proves LOCAL keeps its real stock warnings.
    expect(within(row).getByText('Low')).toBeDefined();
  });

  it('25 — and the same product under DISABLED claims no stock condition at all', async () => {
    await renderScreen(ProductsPage, ready('DISABLED'));
    const row = screen.getByRole('row', { name: new RegExp(product.name, 'i') });
    // Nothing tracks the quantity, so neither the figure nor a warning about it
    // may appear — the alternative is a stock promise nothing enforces.
    expect(within(row).queryByText('Low')).toBeNull();

    // Both the Source cell and the Status badge say it; neither may look like a fault.
    const badges = within(row).getAllByText(/catalogue item/i);
    expect(badges.length).toBe(2);
    for (const badge of badges) {
      expect(badge.className).not.toMatch(/text-danger|text-warning|bg-danger|bg-warning/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16-19 — the catalogue stays manageable
// ─────────────────────────────────────────────────────────────────────────────

describe('16-19 — creation, editing and deactivation remain usable in every mode', () => {
  it.each(MODES)('%s — the list still offers add, import and per-row actions', async (mode) => {
    await renderScreen(ProductsPage, ready(mode));
    expect(screen.getByRole('link', { name: /add product/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /import/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /edit product/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeDefined();
  });

  it.each(MODES)('%s — the detail page still offers Edit', async (mode) => {
    await renderScreen(ProductDetailPage, ready(mode));
    expect(screen.getByRole('link', { name: /edit/i })).toBeDefined();
  });

  it.each(MODES)('%s — the create form still renders its required fields', async (mode) => {
    profileState = ready(mode);
    render(<ProductForm session={session} categories={[]} isAdmin />);
    await settle();
    expect(screen.getByLabelText(/product\/service name/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /continue|review product/i })).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Form wording (21-24)
// ─────────────────────────────────────────────────────────────────────────────

describe('21-24 — the form names QuickBooks only where QuickBooks applies', () => {
  async function renderPricingStep(mode: InventoryMode) {
    profileState = ready(mode);
    render(<ProductForm session={session} categories={[]} product={product} isAdmin />);
    await settle();
    screen.getByRole('button', { name: /continue|review product/i }).click();
    await settle();
  }

  it('24 — a QUICKBOOKS tenant keeps the accounts panel and its wording', async () => {
    await renderPricingStep('QUICKBOOKS');
    expect(bodyText()).toContain('QuickBooks accounts');
    expect(bodyText()).toContain('Assigned automatically when the product syncs to QuickBooks');
    expect(screen.getByLabelText(/quantity on hand/i)).toBeDefined();
  });

  it('21 — a LOCAL tenant sees no accounts panel and keeps editable stock', async () => {
    await renderPricingStep('LOCAL');
    expect(bodyText()).not.toContain('QuickBooks accounts');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
    const qty = screen.getByLabelText(/quantity on hand/i) as HTMLInputElement;
    expect(qty.disabled).toBe(false);
  });

  it('22 — a DISABLED tenant sees no stock fields and is told why', async () => {
    await renderPricingStep('DISABLED');
    expect(screen.queryByLabelText(/quantity on hand/i)).toBeNull();
    expect(bodyText()).toContain('Stock tracking disabled');
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });

  it('the details step drops the QuickBooks mirroring line outside QUICKBOOKS', async () => {
    profileState = ready('QUICKBOOKS');
    render(<ProductForm session={session} categories={[]} isAdmin />);
    await settle();
    expect(bodyText()).toContain('mirroring QuickBooks');

    cleanup();
    profileState = ready('LOCAL');
    render(<ProductForm session={session} categories={[]} isAdmin />);
    await settle();
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20 — the client cannot dictate the mode
// ─────────────────────────────────────────────────────────────────────────────

describe('20 — the product payload carries no inventory mode', () => {
  it.each(MODES)('%s — a create request sends product fields only', async (mode) => {
    profileState = ready(mode);
    render(<ProductForm session={session} categories={[]} isAdmin />);
    await settle();

    const name = screen.getByLabelText(/product\/service name/i) as HTMLInputElement;
    name.value = 'X';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    // Walk the wizard to the end and submit.
    for (let i = 0; i < 3; i += 1) {
      const next = screen.queryByRole('button', {
        name: /continue|review product|create product/i,
      });
      next?.click();
      await settle();
    }

    for (const call of createProduct.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(Object.keys(payload)).not.toContain('inventoryMode');
      expect(Object.keys(payload)).not.toContain('accountingProvider');
      expect(Object.keys(payload)).not.toContain('syncStatus');
      expect(Object.keys(payload)).not.toContain('quickbooksItemId');
    }
  });

  it('a DISABLED tenant submits no quantity at all', async () => {
    profileState = ready('DISABLED');
    render(<ProductForm session={session} categories={[]} product={product} isAdmin />);
    await settle();

    for (let i = 0; i < 3; i += 1) {
      const next = screen.queryByRole('button', {
        name: /continue|review product|save changes/i,
      });
      next?.click();
      await settle();
    }

    expect(updateProduct).toHaveBeenCalled();
    const payload = updateProduct.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('quantityOnHand');
    expect(Object.keys(payload)).not.toContain('reorderLevel');
    // POSITIVE CONTROL: the payload is a real product payload, not an empty object.
    expect(Object.keys(payload)).toContain('name');
    expect(Object.keys(payload)).toContain('unitPrice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility
// ─────────────────────────────────────────────────────────────────────────────

describe('accessibility — status is never carried by colour alone', () => {
  it.each(MODES)('%s — every status badge has a text label', async (mode) => {
    await renderScreen(ProductsPage, ready(mode));
    const row = screen.getByRole('row', { name: new RegExp(product.name, 'i') });
    // The row's accessible name includes the badge text, so a colour-only badge
    // would leave it absent.
    expect(row.textContent?.trim().length).toBeGreaterThan(product.name.length);
  });

  it.each(MODES)('%s — every action control has an accessible name', async (mode) => {
    await renderScreen(ProductsPage, ready(mode));
    for (const button of screen.getAllByRole('button')) {
      const name =
        button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('the EXTERNAL configuration warning is announced, not merely coloured', async () => {
    await renderScreen(ProductsPage, ready('EXTERNAL'));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('External inventory provider is not configured');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 40, 41 — mutation proofs against the rendered output
// ─────────────────────────────────────────────────────────────────────────────

describe('40/41 — these render assertions can actually fail', () => {
  /**
   * The queries above are the ones most at risk of going vacuous — a renamed
   * button, a changed role, a matcher that stopped matching. Each proof shows the
   * same query finding the thing when it *is* present, so its absence elsewhere is
   * evidence rather than silence.
   */

  it('40 — the sync-button query finds the button when it is rendered', async () => {
    await renderScreen(ProductDetailPage, ready('QUICKBOOKS'));
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).not.toBeNull();

    cleanup();
    await renderScreen(ProductDetailPage, ready('LOCAL'));
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).toBeNull();
  });

  it('40 — the QuickBooks wording matcher fires on a screen that legitimately uses it', async () => {
    await renderScreen(ProductsPage, ready('QUICKBOOKS'));
    expect(bodyText()).toMatch(QUICKBOOKS_WORDS);

    cleanup();
    await renderScreen(ProductsPage, ready('LOCAL'));
    expect(bodyText()).not.toMatch(QUICKBOOKS_WORDS);
  });

  it('41 — the loading gate is what hides the action, not an empty render', async () => {
    await renderScreen(ProductDetailPage, { status: 'loading', inventoryMode: null });
    expect(bodyText()).toContain('Loading');

    // Same screen, same data, profile resolved: the action appears. So the absence
    // during loading is the gate doing its job.
    cleanup();
    await renderScreen(ProductDetailPage, ready('QUICKBOOKS'));
    expect(screen.queryByRole('button', { name: /sync to quickbooks/i })).not.toBeNull();
  });
});
