/**
 * D90 — one Save button per tab, and it saves what you are looking at.
 *
 * ## What makes each assertion non-vacuous
 *
 * "The document Save bar is hidden on Charges" would pass for a page that
 * rendered no Save button anywhere, so every negative here is paired with the
 * Business tab still showing it. The tab's OWN button is asserted present at
 * the same time, because the failure this test exists for was two buttons
 * with the wrong one on top — not a missing one.
 *
 * Mutation-proven against the page itself, not a stand-in. Both were run:
 * showing the bar unconditionally fails three of the four (Charges, Hours,
 * and the first half of the return-to-Layout case), and hiding it on every
 * tab fails the other two.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

import type { AppSettings } from '@/lib/settings-api';

const session = {
  user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
  branchId: 'brn_1',
} as never;

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

// Cast through `unknown`: the literal's string fields widen to `string`,
// while DocumentSettings wants the union members. The values ARE valid ones.
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
 * D96 — the settings screen now asks what this workspace prints. A food-service
 * profile, because the two tabs under test (Charges, Hours) edit
 * `RestaurantBranchConfig` and only exist for a workspace that has one; a
 * retail tenant was being shown them by mistake until D96, and opening either
 * answered "Feature not available".
 */
vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor('RESTAURANT').capabilities },
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

const SettingsPage = (await import('./page')).default;

async function openTab(name: string) {
  render(<SettingsPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor(() => expect(screen.getByRole('button', { name })).toBeTruthy());
  await act(async () => {
    screen.getByRole('button', { name }).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const documentSaveBar = () => screen.queryByRole('button', { name: /save changes/i });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('D90 — the Save button on screen saves the record on screen', () => {
  it('the document tabs keep the sticky Save bar', async () => {
    await openTab('Business');
    // POSITIVE CONTROL for every negative below: the bar does exist, and this
    // is the tab it belongs to.
    expect(documentSaveBar()).toBeTruthy();
  });

  it('Charges shows its own Save and hides the document one', async () => {
    await openTab('Charges');
    await waitFor(() => expect(screen.getByRole('button', { name: /save charges/i })).toBeTruthy());

    expect(documentSaveBar()).toBeNull();
  });

  it('Hours shows its own Save and hides the document one', async () => {
    await openTab('Hours');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save opening hours/i })).toBeTruthy(),
    );

    expect(documentSaveBar()).toBeNull();
  });

  it('returning to a document tab brings the bar back', async () => {
    await openTab('Hours');
    expect(documentSaveBar()).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'Layout' }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A bar that never came back would make the negatives above pass while
    // breaking the document profile entirely.
    expect(documentSaveBar()).toBeTruthy();
  });
});
