/**
 * D141 — "Reset to defaults" asks before it resets, in the app's own dialog.
 *
 * ## Why this test exists
 *
 * The reset used to be guarded by `window.confirm`, which is synchronous: the
 * handler could not continue until the browser answered. The replacement is a
 * promise, so the guard is now an `await` — and an `await` that is dropped, or
 * whose result is ignored, wipes a shop's letterhead on a single stray tap with
 * nothing on screen first. That is the failure this file is here to catch.
 *
 * ## What makes each assertion non-vacuous (D30)
 *
 * "Cancelling does not call the API" is also what a page with a broken button,
 * a page that never finished loading, and a page whose dialog never opened all
 * produce. So the cancel case is paired, in the same file and against the same
 * component tree, with a confirm case that asserts the API IS called and that
 * the returned defaults reach the fields — and the first case asserts the
 * dialog is on screen with `resetSettings` still uncalled, which is the exact
 * state a dropped `await` cannot reach.
 *
 * Mutation-proven against the page itself, not a stand-in. Four mutations were
 * run and all four were caught:
 *
 *   1. deleting the `if (!(await confirm(...))) return;` guard — the shape of
 *      the defect this conversion could introduce — fails all five: the reset
 *      fires on the click alone and no dialog is ever on screen.
 *   2. dropping the `!` (`if (await confirm(...)) return;`) fails the three
 *      cases that answer the question — confirming stops resetting, Cancel and
 *      Escape start — while the two that only inspect the open dialog still
 *      pass, so the polarity of the guard is proven by the answers alone.
 *   3. removing `confirmLabel: 'Reset'` fails the wording case and the two that
 *      reach for the button by that verb: a destructive question must not offer
 *      a bare "Confirm".
 *   4. removing `tone: 'danger'` alone fails the wording case, and only that
 *      one, because Cancel stops opening focused.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TIME_ZONE, domainFor } from '@hardware-pos/shared';

import { ConfirmProvider } from '@/components/ui/confirm';
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

const settingsRecord = (taxRatePercent: number): AppSettings => ({
  currency: 'LKR',
  timezone: DEFAULT_TIME_ZONE,
  taxRatePercent,
  taxInclusive: false,
  highDiscountThresholdPercent: 10,
  receiptFooter: '',
  returns: {},
  quotation: {},
  documents,
  sharing: {},
  catalogue: {
    barcodePrefix: null,
    barcodePrefixByCategoryId: {},
    label: {
      widthMm: 38,
      heightMm: 21,
      columns: 5,
      rows: 13,
      marginTopMm: 10,
      marginLeftMm: 5,
      gapXMm: 2,
      gapYMm: 0,
      showProductName: true,
      showVariantOptions: true,
      showPrice: true,
      showSku: false,
      symbology: 'EAN13',
    },
  },
});

/*
 * The stored record and the defaults differ in a field the screen shows, so
 * "the reset happened" is observable in the DOM and not only in a call count:
 * a page that called the endpoint and threw the answer away would still fail.
 */
const STORED_RATE = 18;
const DEFAULT_RATE = 0;

const resetSettings = vi.fn(async (_s: unknown) => settingsRecord(DEFAULT_RATE));

vi.mock('@/lib/settings-api', () => ({
  fetchSettings: async () => settingsRecord(18),
  updateSettings: vi.fn(),
  resetSettings: (s: unknown) => resetSettings(s),
  previewDocument: vi.fn(),
  uploadDocumentAsset: vi.fn(),
  removeDocumentAsset: vi.fn(),
}));

vi.mock('@/lib/products-api', () => ({ resolveImageUrl: (u: string | null) => u }));

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor('HARDWARE').capabilities },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: { get: async () => null, update: vi.fn() },
  openingHours: { get: async () => null, update: vi.fn() },
}));

const SettingsPage = (await import('./page')).default;

/** Lets the awaited confirm, and the reset behind it, settle. */
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/**
 * D141 — the page reads `useConfirm`, which throws outside the provider the
 * authenticated shell mounts. Rendering it here is what makes the dialog real
 * rather than mocked, so the guard is exercised end to end.
 */
async function openSettings() {
  render(
    <ConfirmProvider>
      <SettingsPage />
    </ConfirmProvider>,
  );
  await flush();
  await waitFor(() => expect(rateField()).toBeTruthy());
}

/** The bar's own control. Its full name is "Reset to defaults". */
const resetButton = () => screen.getByRole('button', { name: 'Reset to defaults' });

/** The dialog's confirm. Named by the verb, so it never matches the bar's. */
const confirmButton = () => screen.findByRole('button', { name: 'Reset' });

/** `type="number"` gives the rate input the spinbutton role — precise, not by text. */
const rateField = () =>
  screen.queryByRole('spinbutton', { name: 'Tax rate (%)' }) as HTMLInputElement | null;

async function clickResetToDefaults() {
  await act(async () => {
    resetButton().click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('D141 — the document reset asks before it resets', () => {
  it('asks first: the dialog is on screen and nothing has been reset yet', async () => {
    await openSettings();
    await clickResetToDefaults();

    // The question, split as the operator reads it: what is being done…
    expect(
      screen.getByRole('heading', { name: 'Reset all document settings to defaults?' }),
    ).toBeTruthy();
    // …and the warning the native string carried, which must not be lost.
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();

    // The point of the guard: the click alone changed nothing.
    expect(resetSettings).not.toHaveBeenCalled();
    expect(rateField()!.value).toBe(String(STORED_RATE));
  });

  it('offers a verb, not a bare "Confirm" — this destroys the letterhead', async () => {
    await openSettings();
    await clickResetToDefaults();

    // POSITIVE: the action is named…
    expect(await confirmButton()).toBeTruthy();
    // …and NEGATIVE: the generic label the component falls back to is not what
    // a destructive question shows.
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();

    /*
     * `tone: 'danger'` is not decoration: it opens the dialog with CANCEL
     * focused, so a stray Enter on a tablet does not wipe the letterhead. That
     * behaviour is what is asserted, rather than a class name.
     */
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
  });

  it('confirming resets, and the returned defaults reach the fields', async () => {
    await openSettings();
    await clickResetToDefaults();

    const confirmIt = await confirmButton();
    await act(async () => {
      confirmIt.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(resetSettings).toHaveBeenCalledTimes(1);
    // …with the session, so it is the tenant's own record being reset.
    expect(resetSettings.mock.calls[0]![0]).toBe(session);
    // The whole record comes back from the endpoint, so the rate the page was
    // holding is replaced rather than left stale.
    await waitFor(() => expect(rateField()!.value).toBe(String(DEFAULT_RATE)));
    expect(screen.getByText('Settings reset to defaults')).toBeTruthy();
    // The question is gone; the dialog does not linger over the result.
    expect(screen.queryByRole('heading', { name: 'Reset all document settings to defaults?' })).toBeNull();
  });

  it('Cancel resets nothing and leaves the settings exactly as they were', async () => {
    await openSettings();
    await clickResetToDefaults();

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await act(async () => {
      cancel.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(resetSettings).not.toHaveBeenCalled();
    expect(rateField()!.value).toBe(String(STORED_RATE));
    expect(screen.queryByText('Settings reset to defaults')).toBeNull();
    // The screen is usable again: a promise nobody settled would leave the
    // dialog up and the handler stopped mid-way.
    expect(screen.queryByRole('heading', { name: 'Reset all document settings to defaults?' })).toBeNull();
    expect(resetButton()).toBeTruthy();
  });

  it('Escape means no, exactly as it did natively', async () => {
    await openSettings();
    await clickResetToDefaults();
    expect(await confirmButton()).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(resetSettings).not.toHaveBeenCalled();
    expect(rateField()!.value).toBe(String(STORED_RATE));
  });
});
