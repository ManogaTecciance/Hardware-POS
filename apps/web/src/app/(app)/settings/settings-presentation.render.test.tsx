/**
 * D96 — Settings shows the document this workspace actually prints.
 *
 * ## What makes each assertion non-vacuous
 *
 * "The restaurant has no signature upload" is also what a settings page that
 * failed to render produces, and "the retail tenant has one" is what a page
 * ignoring the resolver produces. So the two profiles are asserted against each
 * other on every control: present for retail, absent for restaurant, in the
 * same test, with a positive control (the logo, which both keep) proving the
 * Branding tab rendered at all.
 *
 * The profile mock is swapped per test rather than per file so both halves run
 * against ONE component tree — two files would let the retail half keep passing
 * while the restaurant half was never wired.
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

const documents = {
  companyName: 'Praneetha',
  addressLine: '201 Muhandiram Road',
  phone: '0112 33 33 99',
  email: null,
  taxNumber: null,
  logoUrl: null,
  signatureUrl: null,
  stampUrl: null,
  footerText: 'Thank You! Come Again.',
  billNote: 'Prices include service charge.',
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
  /*
   * D99 — deliberately NOT the shipped 78/3/5. The preview iframe and the
   * calibration fields both have to read this workspace's own numbers, and at
   * the defaults a component that ignored them entirely would look correct.
   */
  billPaperWidthMm: 58,
  billLeftInsetMm: 2,
  billRightInsetMm: 4,
  billFitToContent: true,
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
  previewDocument: vi.fn(async () => '<html><body>A4 preview</body></html>'),
  uploadDocumentAsset: vi.fn(),
  removeDocumentAsset: vi.fn(),
}));

vi.mock('@/lib/products-api', () => ({ resolveImageUrl: (u: string | null) => u }));

vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: { get: async () => ({}), update: vi.fn() },
  openingHours: {
    get: async () => ({ branchId: 'brn_1', weekly: [], overrides: [], defaults: { opensAt: 480, closesAt: 1380 } }),
    update: vi.fn(),
  },
}));

/** Swapped per test — see the file docblock. */
let businessType: 'HARDWARE' | 'RESTAURANT' | null = 'HARDWARE';

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: businessType ? 'ready' : 'loading',
    profile: businessType
      ? { capabilities: domainFor(businessType).capabilities, enabledModules: [] }
      : null,
    inventoryMode: null,
    refresh: vi.fn(),
  }),
}));

const SettingsPage = (await import('./page')).default;

async function open(tab: string) {
  render(<SettingsPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: tab })).toBeTruthy());
  await act(async () => {
    screen.getByRole('button', { name: tab }).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const tabNames = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((t) => ['Business', 'Branding', 'Layout', 'Preview', 'Charges', 'Hours', 'Workspace'].includes(t));

beforeEach(() => {
  businessType = 'HARDWARE';
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('D96 — the Branding tab', () => {
  it('a retail workspace keeps the signature, stamp, accent colour and logo placement', async () => {
    await open('Branding');

    expect(screen.getByText('Authorized signature')).toBeTruthy();
    expect(screen.getByText('Company stamp / seal')).toBeTruthy();
    expect(screen.getByLabelText('Accent colour')).toBeTruthy();
    expect(screen.getByText('Logo alignment')).toBeTruthy();
    expect(screen.getByText('Business logo')).toBeTruthy();
  });

  it('a bill workspace keeps only the logo', async () => {
    businessType = 'RESTAURANT';
    await open('Branding');

    // POSITIVE CONTROL first: the tab rendered, and the one branding field the
    // bill actually prints is still here (D86 put the logo on the receipt).
    expect(screen.getByText('Business logo')).toBeTruthy();

    // The PO's list, by the exact labels they used.
    expect(screen.queryByText('Authorized signature')).toBeNull();
    expect(screen.queryByText('Company stamp / seal')).toBeNull();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
    expect(screen.queryByText('Logo alignment')).toBeNull();
    expect(screen.queryByText('Logo size')).toBeNull();
  });
});

describe('D96 — the Layout tab', () => {
  it('a retail workspace keeps the page setup and the document columns', async () => {
    await open('Layout');

    expect(screen.getByText('Paper size')).toBeTruthy();
    expect(screen.getByText('Margins')).toBeTruthy();
    expect(screen.getByText('Product SKU column')).toBeTruthy();
    expect(screen.getByText('Signature area')).toBeTruthy();
    expect(screen.queryByText('What prints on the bill')).toBeNull();
  });

  it('a bill workspace gets what prints on the bill instead', async () => {
    businessType = 'RESTAURANT';
    await open('Layout');

    expect(screen.getByText('What prints on the bill')).toBeTruthy();
    expect(screen.getByText(/continuous roll/)).toBeTruthy();
    // NEGATIVE — none of the A4 controls survive.
    for (const gone of ['Paper size', 'Margins', 'Product SKU column', 'Signature area', 'Page numbers']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });
});

describe('D96 — the Preview tab', () => {
  it('a retail workspace previews a quotation, as it always has', async () => {
    await open('Preview');

    expect(screen.getByText('Document type')).toBeTruthy();
    expect(screen.queryByTitle('Bill preview')).toBeNull();
  });

  it('a bill workspace previews the bill', async () => {
    businessType = 'RESTAURANT';
    await open('Preview');

    const frame = screen.getByTitle('Bill preview') as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    // It is the REAL bill template, fed the tab's own document settings — the
    // company name and the bill note both reach the paper.
    expect(frame.srcdoc).toContain('Praneetha');
    expect(frame.srcdoc).toContain('Prices include service charge.');
    expect(frame.srcdoc).toContain('DESCRIPTION');
    // NEGATIVE — the A4 chooser is gone with it.
    expect(screen.queryByText('Document type')).toBeNull();
  });

  it('D99 — a bill workspace can measure its roll here', async () => {
    businessType = 'RESTAURANT';
    await open('Preview');

    expect(screen.getByLabelText('Paper width (mm)')).toBeTruthy();
    expect(screen.getByLabelText('Left inset (mm)')).toBeTruthy();
    expect(screen.getByLabelText('Right inset (mm)')).toBeTruthy();
    expect(screen.getByText('Print calibration strip')).toBeTruthy();

    // The fields and the preview both show THIS workspace's numbers, not the
    // shipped defaults — 58mm is 219px, where 78mm would be 295px.
    expect((screen.getByLabelText('Paper width (mm)') as HTMLInputElement).value).toBe('58');
    const frame = screen.getByTitle('Bill preview') as HTMLIFrameElement;
    expect(frame.style.width).toBe('219px');
    expect(frame.srcdoc).toContain('padding:0 4mm 0 2mm');
  });

  it('D99 — a retail workspace is offered no roll to calibrate', async () => {
    await open('Preview');

    // NEGATIVE: an A4 sheet's geometry belongs to the driver, and the fields
    // would be settings that change nothing — the defect D96 was written for.
    expect(screen.queryByLabelText('Paper width (mm)')).toBeNull();
    expect(screen.queryByText('Print calibration strip')).toBeNull();
    // POSITIVE CONTROL: the Preview tab did render.
    expect(screen.getByText('Document type')).toBeTruthy();
  });
});

describe('D96 — which tabs exist', () => {
  it('a retail workspace is not offered the restaurant-only tabs', async () => {
    await open('Business');

    const names = tabNames();
    expect(names).toContain('Business');
    expect(names).toContain('Workspace');
    // The defect this fixes: a Tile Shop owner opening either got "Feature not
    // available", because both edit a row a retail tenant has none of.
    expect(names).not.toContain('Charges');
    expect(names).not.toContain('Hours');
  });

  it('a bill workspace gets them', async () => {
    businessType = 'RESTAURANT';
    await open('Business');

    const names = tabNames();
    expect(names).toContain('Charges');
    expect(names).toContain('Hours');
    expect(names).toContain('Workspace');
  });

  it('an unresolved profile offers neither, and previews nothing', async () => {
    businessType = null;
    render(<SettingsPage />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const names = tabNames();
    expect(names).not.toContain('Charges');
    expect(names).not.toContain('Hours');
    // POSITIVE CONTROL: the page still rendered its document tabs.
    expect(names).toContain('Branding');
  });
});

describe('D95 — the Workspace tab', () => {
  it('replaces the hyperlink, and shows what the workspace is', async () => {
    await open('Workspace');

    const panel = screen.getByRole('region', { name: 'Workspace configuration' });
    expect(panel).toBeTruthy();
    // NEGATIVE — the link it replaced is gone from the header.
    expect(screen.queryByRole('link', { name: 'Workspace configuration' })).toBeNull();
  });
});
