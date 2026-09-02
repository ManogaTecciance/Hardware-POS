/**
 * 3.15 — the tenant-wide tax rate is reachable from Settings.
 *
 * ## Why this test exists
 *
 * Phase 3 gave every product a Taxable switch (3.13) and made that switch bite
 * on both the server and the till (3.10, 3.14) — but `taxRatePercent` itself was
 * writable only through `PUT /v1/settings`. An owner could zero-rate one shirt
 * and never set the rate everything else was charged at. Found by the operator,
 * not by a test, which is the third time on this branch.
 *
 * ## What makes each assertion non-vacuous (D30)
 *
 * "The rate is absent for a user without the permission" would pass for a page
 * that rendered nothing at all, so that case also asserts the refusal copy IS
 * on screen and pairs with a permitted render that finds the field enabled.
 *
 * The save assertion inspects the PUT BODY rather than trusting that a click
 * happened. A test that only asserted `updateSettings` was called would pass for
 * a page that dropped the rate on the floor and sent `{ documents }` alone —
 * which is exactly what this page did before this step, and exactly the bug.
 *
 * Mutation-proven against the page itself, not a stand-in. Both mutations were
 * run and both were caught:
 *
 *   1. sending `{ documents: docs }` without `taxRatePercent` — the shape of the
 *      original defect — fails TWO cases: "sends the rate it was given" and
 *      "accepts 0", the second because the mutated page never sends 0 either.
 *   2. dropping the `!taxRateValid` guard out of `save()` fails both refusal
 *      cases (out-of-range, and an emptied box) and no others.
 *
 * Neither mutation was caught by only one assertion, and neither left the file
 * green — which is the property being claimed here.
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

/** Flipped per test. `useAuth` is mocked once; the answer is not constant. */
const auth = { canManage: true };
/** Flipped per test, so one suite covers retail AND food service. */
const tenant = { businessType: 'RETAIL' as 'RETAIL' | 'RESTAURANT' };

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
  useAuth: () => ({ session, hasPermission: () => auth.canManage }),
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
  taxRatePercent,
  taxInclusive: false,
  highDiscountThresholdPercent: 10,
  receiptFooter: '',
  returns: {},
  quotation: {},
  documents,
  sharing: {},
});

const updateSettings = vi.fn(async (_s: unknown, input: { taxRatePercent?: number }) =>
  settingsRecord(input.taxRatePercent ?? 18),
);

vi.mock('@/lib/settings-api', () => ({
  fetchSettings: async () => settingsRecord(18),
  updateSettings: (s: unknown, input: { taxRatePercent?: number }) => updateSettings(s, input),
  resetSettings: vi.fn(),
  previewDocument: vi.fn(),
  uploadDocumentAsset: vi.fn(),
  removeDocumentAsset: vi.fn(),
}));

vi.mock('@/lib/products-api', () => ({ resolveImageUrl: (u: string | null) => u }));

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor(tenant.businessType).capabilities },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: { get: async () => null, update: vi.fn() },
  openingHours: { get: async () => null, update: vi.fn() },
}));

const SettingsPage = (await import('./page')).default;

async function openBusinessTab() {
  render(<SettingsPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Business' })).toBeTruthy());
  await act(async () => {
    screen.getByRole('button', { name: 'Business' }).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** `type="number"` gives the input the spinbutton role — precise, not by text. */
const rateField = () =>
  screen.queryByRole('spinbutton', { name: 'Tax rate (%)' }) as HTMLInputElement | null;

const saveButton = () => screen.getByRole('button', { name: /save changes/i });

/** React owns the value; setting `.value` directly is not seen by onChange. */
async function typeRate(value: string) {
  const input = rateField()!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.canManage = true;
  tenant.businessType = 'RETAIL';
});
afterEach(cleanup);

describe('3.15 — the tax rate is reachable from Settings > Business', () => {
  it('renders the stored rate, and the tab keeps everything it already had', async () => {
    await openBusinessTab();

    // The feature itself.
    expect(rateField()).toBeTruthy();
    expect(rateField()!.value).toBe('18');

    /*
     * ZERO-BREAKAGE. The rate was inserted into an existing tab, so the fields
     * that were already there must still be there. Named individually rather
     * than counted: a count passes when one field is swapped for another.
     */
    expect(screen.getByText('Business name')).toBeTruthy();
    expect(screen.getByText('Tax / VAT number')).toBeTruthy();
    expect(screen.getByText('Phone')).toBeTruthy();
    expect(screen.getByText('Email')).toBeTruthy();
    // The new label is distinct from the VAT-number one it sits beside; a
    // shopkeeper must not confuse "what rate" with "what registration number".
    expect(screen.getByText('Tax rate (%)')).toBeTruthy();
    // …and the bar that saves them, which this step had to modify.
    expect(saveButton()).toBeTruthy();
  });

  it('sends the rate it was given — the PUT body, not just the call', async () => {
    await openBusinessTab();
    await typeRate('12.5');

    await act(async () => {
      saveButton().click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    const call = updateSettings.mock.calls[0];
    expect(call).toBeTruthy();
    const body = call![1];
    // The rate reaches the server…
    expect(body.taxRatePercent).toBe(12.5);
    // …as a NUMBER. The field holds the typed string; sending "12.5" would be
    // refused by `@IsNumber()` on UpdateSettingsDto.
    expect(typeof body.taxRatePercent).toBe('number');
    // …and the document profile still rides along, unharmed.
    expect((body as { documents?: unknown }).documents).toBeTruthy();
  });

  it('Save stays disabled until something actually changes', async () => {
    await openBusinessTab();

    // NEGATIVE: nothing edited, nothing to save.
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

    // POSITIVE CONTROL: the same button enables once the rate is edited, which
    // proves the assertion above is about dirtiness and not a dead button.
    await typeRate('20');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses a rate outside 0–100 and does not call the API', async () => {
    await openBusinessTab();
    await typeRate('150');

    await act(async () => {
      saveButton().click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // The server would refuse it (@Max(100)); the screen refuses it first.
    expect(updateSettings).not.toHaveBeenCalled();
    // Two messages, deliberately: one under the field being corrected…
    expect(screen.getByText('Enter a number between 0 and 100.')).toBeTruthy();
    // …and one in the page banner, where errors from a failed save also land,
    // so a click never looks like it silently did nothing.
    expect(screen.getByText(/Tax rate must be a number/i)).toBeTruthy();
  });

  it('refuses an emptied field rather than silently saving 0', async () => {
    await openBusinessTab();
    await typeRate('');

    await act(async () => {
      saveButton().click();
      await new Promise((r) => setTimeout(r, 0));
    });

    /*
     * A cleared box is not "no tax". Coercing '' to 0 would zero-rate an entire
     * shop on a stray backspace, and Number('') is 0, so this is one keystroke
     * away by default.
     */
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('accepts 0 — a real rate, and different from an empty box', async () => {
    await openBusinessTab();
    await typeRate('0');

    await act(async () => {
      saveButton().click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    const zeroCall = updateSettings.mock.calls[0];
    expect(zeroCall).toBeTruthy();
    expect(zeroCall![1].taxRatePercent).toBe(0);
  });
});

describe('3.15 — SETTINGS_MANAGE gates the rate', () => {
  /*
   * The page does NOT render read-only for a user without the permission: it
   * blocks outright ("block the page outright rather than rendering it
   * read-only"), a pre-existing decision this step deliberately did not weaken.
   * So the gate on the rate is the page's own, and that is what is asserted —
   * not a read-only field that does not exist.
   *
   * The field still carries `disabled={!canManage}` like every sibling on the
   * tab, so if that early return is ever relaxed the rate does not become the
   * one writable control on a read-only screen.
   */
  it('without SETTINGS_MANAGE the whole page is blocked, rate included', async () => {
    auth.canManage = false;
    render(<SettingsPage />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // POSITIVE: the refusal is what renders…
    expect(screen.getByText(/don.t have access to settings/i)).toBeTruthy();
    // NEGATIVE: …and the rate is genuinely absent, not merely disabled.
    expect(rateField()).toBeNull();
    // POSITIVE CONTROL: the tab itself is gone too, which is why the probe
    // above finding nothing means "blocked" and not "query typo".
    expect(screen.queryByRole('button', { name: 'Business' })).toBeNull();
  });

  it('with SETTINGS_MANAGE the rate is present and editable — the control', async () => {
    auth.canManage = true;
    await openBusinessTab();

    expect(rateField()).toBeTruthy();
    expect(rateField()!.disabled).toBe(false);
  });
});

describe('3.15 — every template, because every template reads this rate', () => {
  it('food service gets the field too', async () => {
    /*
     * `restaurant-totals.ts` documents its rate as coming "from the tenant's
     * AppSettings.taxRatePercent" — the same field. Hiding it from a restaurant
     * owner would leave them exactly as stuck as a retail one, and would need a
     * business-type conditional, which is the scattered comparison D56 ends.
     */
    tenant.businessType = 'RESTAURANT';
    await openBusinessTab();

    expect(rateField()).toBeTruthy();
    expect(rateField()!.value).toBe('18');
  });

  it('retail gets it as well — both arms asserted, not just the new one', async () => {
    tenant.businessType = 'RETAIL';
    await openBusinessTab();

    expect(rateField()).toBeTruthy();
  });
});
