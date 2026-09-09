/**
 * D138 — the Business details tab appears for retail, and for nobody else.
 *
 * ## Why this is a separate file from `settings-tabs.render.test.tsx`
 *
 * That spec pins the profile to `RESTAURANT` at module scope, because the tabs
 * it covers only exist for a food-service workspace. `vi.mock` is hoisted, so
 * the business type cannot be varied inside it without rewriting its harness —
 * and its assertions are existing behaviour, which a new feature does not get
 * to edit (D16). So this file mocks the same graph with a **switchable**
 * business type and asserts one thing the other cannot.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * `document-presentation.test.ts` already proves the FLAG is right for every
 * business type. That proves nothing about the screen: a page that ignored the
 * flag entirely would pass all of it. This closes the loop by rendering the
 * REAL page and looking for the real tab.
 *
 * Every case is paired. "Hardware has no Business details tab" would hold for a
 * page that rendered no tabs at all, so each case also asserts a tab that must
 * still be there — and the retail case asserts the tab IS present against the
 * same page, so neither half can pass alone.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUSINESS_TYPE_VALUES, domainFor, type BusinessType } from '@hardware-pos/shared';

import type { AppSettings } from '@/lib/settings-api';

const session = {
  user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
  branchId: 'brn_1',
} as never;

/** Read inside the hoisted `vi.mock` factory, so each test can set it. */
let businessType: BusinessType = 'RETAIL';

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

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session, hasPermission: () => true }),
}));

const documents = {
  companyName: 'Praneetha',
  addressLine: null,
  phone: null,
  email: null,
  taxNumber: null,
  logoUrl: null,
  signatureUrl: null,
  stampUrl: null,
  footerText: '',
  billNote: '',
  accentColor: '#000000',
  logoAlignment: 'LEFT',
  logoSize: 'MEDIUM',
  marginStyle: 'NORMAL',
  defaultPaperSize: 'A4',
  orientation: 'PORTRAIT',
  showProductImages: false,
  showSku: true,
  showTaxColumn: true,
  showDiscountColumn: true,
  showCustomerTaxNumber: false,
  showPageNumbers: true,
  defaultBillFormat: 'A4',
  signatureFields: false,
} as unknown as AppSettings['documents'];

vi.mock('@/lib/settings-api', () => ({
  fetchSettings: async () => ({
    currency: 'LKR',
    taxRatePercent: 0,
    taxInclusive: false,
    highDiscountThresholdPercent: 10,
    receiptFooter: '',
    returns: {},
    quotation: {},
    documents,
    sharing: {},
  }),
  updateSettings: vi.fn(),
  resetSettings: vi.fn(),
  previewDocument: vi.fn(),
  uploadDocumentAsset: vi.fn(),
  removeDocumentAsset: vi.fn(),
}));

vi.mock('@/lib/products-api', () => ({ resolveImageUrl: (u: string | null) => u }));

/*
 * The REAL capabilities, from the REAL registry, for whichever business type
 * the case under test selected. Hand-written capability objects would let this
 * pass while the registry said something else — the failure D56 exists for.
 */
vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor(businessType).capabilities },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: {
    get: async () => ({
      branchId: 'brn_1',
      serviceChargePercent: '10.00',
      serviceChargeChannels: ['DINE_IN'],
      serviceChargeTaxable: true,
      packagingChargeAmount: '0.00',
      takeawayEnabled: true,
      dineInEnabled: true,
      defaultTicketTargetMinutes: null,
      version: 1,
      updatedAt: new Date(0).toISOString(),
    }),
    update: vi.fn(),
  },
  openingHours: {
    get: async () => ({
      branchId: 'brn_1',
      weekly: [],
      overrides: [],
      defaults: { opensAt: 480, closesAt: 1380 },
    }),
    update: vi.fn(),
  },
}));

/*
 * The tab itself is covered by its own spec; here it must not issue a request
 * merely by being rendered, and it must not be what decides its own visibility.
 */
vi.mock('@/lib/products/business-details-api', () => ({
  fetchBusinessDetailsConfig: vi.fn(async () => ({ fields: [], source: 'DOMAIN' })),
  replaceBusinessDetails: vi.fn(),
}));

const SettingsPage = (await import('./page')).default;

async function renderAs(type: BusinessType) {
  businessType = type;
  render(<SettingsPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  // The page loads settings before it draws anything; wait for a tab that
  // exists for every business type, so a case never asserts against a spinner.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Business' })).toBeTruthy());
}

const businessDetailsTab = () =>
  screen.queryByRole('button', { name: 'Business details' });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('D138 — who is shown the Business details tab', () => {
  it('a retail workspace is offered it', async () => {
    await renderAs('RETAIL');

    // POSITIVE — the tab is on screen…
    expect(businessDetailsTab()).not.toBeNull();
    // …and it is a NEW tab, not a rename: the ones that were there still are.
    expect(screen.getByRole('button', { name: 'Business' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Branding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeTruthy();
  });

  it('a hardware workspace is not, and its own tabs are untouched', async () => {
    await renderAs('HARDWARE');

    // NEGATIVE, and paired: the page rendered, it simply has no such tab.
    expect(businessDetailsTab()).toBeNull();
    expect(screen.getByRole('button', { name: 'Business' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Branding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Layout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeTruthy();
  });

  it('a restaurant workspace is not, and keeps Charges and Hours', async () => {
    await renderAs('RESTAURANT');

    expect(businessDetailsTab()).toBeNull();
    // The food-service tabs D96 gated are still exactly where they were, so
    // this feature is proven not to have disturbed the other gate beside it.
    expect(screen.getByRole('button', { name: 'Charges' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hours' })).toBeTruthy();
  });

  it('opening it renders the editor rather than a dead tab', async () => {
    await renderAs('RETAIL');

    await act(async () => {
      businessDetailsTab()!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // POSITIVE — the tab's own screen, with its own Save button…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save business details/i })).toBeTruthy(),
    );
    // …and NEGATIVE (D90) — not the document Save bar, which saves a record the
    // operator is not looking at.
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
  });

  it('every other business type is refused it — the whole registry, walked', async () => {
    /*
     * The exact map, so a NEW business type arrives here as a named failure
     * rather than quietly inheriting whichever answer its capabilities give.
     * Rendered against the real page, one type at a time.
     */
    const shown: Record<string, boolean> = {};
    for (const type of BUSINESS_TYPE_VALUES) {
      await renderAs(type);
      shown[type] = businessDetailsTab() !== null;
      cleanup();
    }

    expect(shown).toEqual({
      HARDWARE: false,
      RESTAURANT: false,
      CAFE: false,
      BAKERY: false,
      HOTEL: false,
      GENERAL: false,
      RETAIL: true,
    });
    expect(Object.keys(shown)).toHaveLength(BUSINESS_TYPE_VALUES.length);
    /*
     * 30s, and not because this is flaky: it mounts the WHOLE settings page
     * seven times, which does not fit the 5s default once the rest of the suite
     * is running beside it. Asserting a subset to fit the budget would give up
     * the one property this case exists for -- that a business type added later
     * shows up here by name.
     */
  }, 30_000);
});
