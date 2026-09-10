/**
 * D152 — a retail workspace's Settings: thermal bill, A4 quotations.
 *
 * ## Why a separate file from `settings-presentation.render.test.tsx`
 *
 * That spec's profile mock is typed `'HARDWARE' | 'RESTAURANT' | null`, and its
 * cases are D96's existing behaviour, which a new feature does not get to edit
 * (D16). Retail is a third answer, so it gets its own file rather than a
 * widened union threaded through assertions that were never about it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The obvious wrong implementation of "retail only needs a thermal bill" is to
 * make retail behave like a restaurant. That passes any test that only checks
 * the bill arrived — and it would strip the letterhead controls off a workspace
 * that still issues quotations, which nobody would notice until somebody tried
 * to brand one.
 *
 * So every case here asserts BOTH halves against ONE render: the thermal thing
 * that must now be present, and the A4 thing that must still be. A restaurant
 * comparison runs against the same component tree, so "retail kept its A4
 * controls" cannot pass because the page ignored the resolver entirely.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor, type BusinessType } from '@hardware-pos/shared';

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
  billNote: 'Exchange within 7 days.',
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
  // Not the shipped defaults, so a component ignoring them looks wrong.
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
    get: async () => ({
      branchId: 'brn_1',
      weekly: [],
      overrides: [],
      defaults: { opensAt: 480, closesAt: 1380 },
    }),
    update: vi.fn(),
  },
}));

// The Business details tab is retail-only (D150) and would issue a request the
// moment it mounts. Its own spec covers it; here it must not be the thing that
// decides whether the page renders.
vi.mock('@/lib/products/business-details-api', () => ({
  fetchBusinessDetailsConfig: vi.fn(async () => ({ fields: [], source: 'DOMAIN' })),
  replaceBusinessDetails: vi.fn(),
}));

/** Swapped per test, and read from the REAL registry. */
let businessType: BusinessType = 'RETAIL';

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: 'ready',
    profile: { capabilities: domainFor(businessType).capabilities, enabledModules: [] },
    inventoryMode: null,
    refresh: vi.fn(),
  }),
}));

const SettingsPage = (await import('./page')).default;

/*
 * D145 — the page asks its questions through <ConfirmProvider>, which the
 * authenticated shell mounts. `useConfirm` throws outside it rather than
 * falling back to `window.confirm`, so every render here supplies it.
 */
async function open(tab: string) {
  render(
    <ConfirmProvider>
      <SettingsPage />
    </ConfirmProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: tab })).toBeTruthy());
  await act(async () => {
    screen.getByRole('button', { name: tab }).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  businessType = 'RETAIL';
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('D152 — the Branding tab keeps the letterhead retail still quotes on', () => {
  it('retail keeps the signature, stamp, accent colour and logo placement', async () => {
    await open('Branding');

    // These belong to the QUOTATION, which retail still issues. If the bill
    // change had been implemented as "retail becomes a restaurant", every one
    // of them would be gone.
    expect(screen.getByText('Authorized signature')).toBeTruthy();
    expect(screen.getByText('Company stamp / seal')).toBeTruthy();
    expect(screen.getByLabelText('Accent colour')).toBeTruthy();
    expect(screen.getByText('Logo alignment')).toBeTruthy();
    expect(screen.getByText('Business logo')).toBeTruthy();
  });

  it('…and a restaurant still does not, against the same page', async () => {
    // The paired half. Without it the case above would pass for a page that
    // rendered every control unconditionally.
    businessType = 'RESTAURANT';
    await open('Branding');

    expect(screen.getByText('Business logo')).toBeTruthy();
    expect(screen.queryByText('Authorized signature')).toBeNull();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
  });
});

describe('D152 — the Layout tab gains the bill without losing the page', () => {
  it('retail gets the bill summary AND the A4 page setup', async () => {
    await open('Layout');

    // NEW: what the slip contains, since the bill has no settings of its own.
    expect(screen.getByText('What prints on the bill')).toBeTruthy();
    // STILL HERE: the quotation's page. This is the pair that matters —
    // neither the restaurant surface nor the old A4 surface produces both.
    expect(screen.getByText('Paper size')).toBeTruthy();
    expect(screen.getByText('Margins')).toBeTruthy();
    expect(screen.getByText('Product SKU column')).toBeTruthy();
    expect(screen.getByText('Signature area')).toBeTruthy();
  });

  it('the note says which settings apply to what', async () => {
    await open('Layout');

    // A retail owner sees page-size controls and a bill summary on one tab.
    // The restaurant's flat "there is no page size" would be a contradiction.
    expect(screen.getByText(/settings above apply to your A4 documents/i)).toBeTruthy();
  });
});

describe('D152 — the Preview tab shows both documents', () => {
  it('retail previews the bill it prints and the quotation it sends', async () => {
    await open('Preview');

    // The bill, rendered from the real template with this workspace's numbers.
    const frame = screen.getByTitle('Bill preview') as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.srcdoc).toContain('Praneetha');
    // …and the A4 chooser, which a restaurant does not get.
    expect(screen.getByText('Document type')).toBeTruthy();
  });

  it('but offers no A4 invoice, because retail can no longer print one', async () => {
    await open('Preview');

    const chooser = screen.getByLabelText('Document type') as HTMLSelectElement;
    const options = Array.from(chooser.options).map((o) => o.textContent);

    // POSITIVE — the documents retail still produces are all offered…
    expect(options).toContain('Quotation');
    expect(options).toContain('Return / Refund');
    expect(options).toContain('Exchange');
    // …NEGATIVE — and the one it cannot is not. Previewing a document the
    // operator has no way to print is the dead control D96 exists to remove.
    expect(options).not.toContain('Invoice / Bill');
  });

  it('a hardware workspace still gets the A4 invoice, and no bill preview', async () => {
    /*
     * The isolation case. Hardware shares `RETAIL_CAPABILITIES` with retail, so
     * a change made in the wrong constant reaches it — and its A4 bill is the
     * document this whole screen was built for.
     */
    businessType = 'HARDWARE';
    await open('Preview');

    const chooser = screen.getByLabelText('Document type') as HTMLSelectElement;
    expect(Array.from(chooser.options).map((o) => o.textContent)).toContain('Invoice / Bill');
    expect(screen.queryByTitle('Bill preview')).toBeNull();
  });

  it('retail can measure its roll, which it could not before', async () => {
    await open('Preview');

    // D99's calibration follows the bill onto whichever surface prints one.
    expect(screen.getByLabelText('Paper width (mm)')).toBeTruthy();
    expect(screen.getByLabelText('Left inset (mm)')).toBeTruthy();
  });
});

describe('D153 — the bill preview shows goods the workspace actually sells', () => {
  it('retail sees a shop basket, not a restaurant menu', async () => {
    await open('Preview');
    const bill = (screen.getByTitle('Bill preview') as HTMLIFrameElement).srcdoc;

    // POSITIVE — clothing AND groceries, because RETAIL is one business type
    // covering both and a sample showing one would look wrong to the other.
    expect(bill).toContain('Cotton Shirt');
    expect(bill).toContain('Basmati Rice');

    // NEGATIVE — the restaurant menu that was being shown here. This is the
    // reported bug, stated as an assertion.
    for (const dish of ['Chicken Fried Rice', 'Grilled Seer', 'Vegetable Kottu', 'Black Coffee']) {
      expect(bill, dish).not.toContain(dish);
    }
  });

  it('and no service charge or table, which a shop does not have', async () => {
    await open('Preview');
    const bill = (screen.getByTitle('Bill preview') as HTMLIFrameElement).srcdoc;

    // Previewing a service-charge row to a shop is previewing a line its bill
    // will never print; a table number on a counter sale is meaningless.
    expect(bill).not.toContain('Service charge');
    expect(bill).not.toContain('M1/04');
    expect(bill).not.toContain('Served By');
    // …and the positive control: the rows a retail bill DOES have are there,
    // so this cannot pass because the preview rendered nothing.
    expect(bill).toContain('Discount');
    expect(bill).toContain('Bill Amount');
  });

  it('a restaurant still sees its own menu and its service charge', async () => {
    /*
     * The paired half, and the one that proves this change stayed on retail's
     * side of the line. Food service read this sample long before retail did.
     */
    businessType = 'RESTAURANT';
    await open('Preview');
    const bill = (screen.getByTitle('Bill preview') as HTMLIFrameElement).srcdoc;

    expect(bill).toContain('Chicken Fried Rice');
    expect(bill).toContain('Service charge');
    expect(bill).not.toContain('Cotton Shirt');
  });
});

/**
 * D157 — the two previews share the tab instead of stacking.
 *
 * ## The report
 *
 * D152 gave retail both previews by putting one under the other. A thermal
 * bill is a metre of paper, so reaching the quotation meant scrolling past a
 * whole receipt and neither document could be seen whole.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * "Not stacked" is a claim about what is VISIBLE, and the panel that is hidden
 * is still in the DOM — deliberately, so the A4 chooser keeps its selection.
 * So `getByText`/`getByTitle` cannot state it: they find hidden nodes and would
 * pass just as happily against the stacked layout this replaces.
 *
 * `getByRole` omits `hidden` subtrees, and its singular form throws on more
 * than one match. `screen.getByRole('tabpanel')` therefore asserts EXACTLY ONE
 * visible panel, and fails against the old layout for the right reason. Every
 * case below reads through it, and pairs the document that must be on screen
 * with the one that must not.
 *
 * The last two cases are the isolation halves: hardware and restaurant preview
 * one document each and must gain no toggle at all. Each asserts the preview
 * they DO have, so "no tabs" cannot pass because the page rendered nothing.
 */
describe('D157 — the Preview tab switches between the two documents', () => {
  /** The one panel a user can actually see. Throws if the layout stacks. */
  const visiblePanel = () => screen.getByRole('tabpanel');

  const flipTo = async (name: string) => {
    await act(async () => {
      screen.getByRole('tab', { name }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('offers exactly two documents, bill first', async () => {
    await open('Preview');

    // An exact set, not a count: a third segment, a renamed one, or a reorder
    // are all different products and all fail here. Bill first is the decision
    // — it is the document that goes to a customer on every single sale.
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual([
      'Printed bill',
      'A4 documents',
    ]);
  });

  it('shows the bill alone on arrival, not the quotation beneath it', async () => {
    await open('Preview');

    // POSITIVE — the bill is the one on screen…
    expect(within(visiblePanel()).getByTitle('Bill preview')).toBeTruthy();
    // …NEGATIVE — and the A4 chooser is NOT, which is the reported defect
    // stated as an assertion. Under the stacked layout both were visible and
    // `visiblePanel()` itself would have thrown.
    expect(within(visiblePanel()).queryByLabelText('Document type')).toBeNull();

    expect(screen.getByRole('tab', { name: 'Printed bill' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('swaps to the A4 documents, and puts the bill away', async () => {
    await open('Preview');
    await flipTo('A4 documents');

    // The mirror image of the case above, against the same render. A toggle
    // that showed everything, or one that showed nothing, fails one half each.
    expect(within(visiblePanel()).getByLabelText('Document type')).toBeTruthy();
    expect(within(visiblePanel()).queryByTitle('Bill preview')).toBeNull();

    expect(screen.getByRole('tab', { name: 'A4 documents' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Printed bill' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('the A4 chooser keeps its document across a flip', async () => {
    /*
     * Why the hidden panel stays mounted rather than being rendered
     * conditionally. `PreviewTab` holds the chosen document type in its own
     * state, defaulting to 'quotation'; unmounting it on every flip would send
     * an operator comparing a return slip against the bill back to the start
     * each time. A `{cond ? <A/> : <B/>}` implementation resets it and fails.
     */
    await open('Preview');
    await flipTo('A4 documents');

    const chooser = screen.getByLabelText('Document type') as HTMLSelectElement;
    await act(async () => {
      chooser.value = 'return';
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    // The control moved at all — without this the case could pass on a
    // chooser that ignored the change and sat on its default throughout.
    expect((screen.getByLabelText('Document type') as HTMLSelectElement).value).toBe('return');

    await flipTo('Printed bill');
    await flipTo('A4 documents');

    expect((screen.getByLabelText('Document type') as HTMLSelectElement).value).toBe('return');
  });

  it('the choice survives a trip to another tab and back', async () => {
    /*
     * Why the state lives on the page rather than inside the Preview panel.
     * The loop an operator actually works in is: change the logo, look at the
     * bill, change it again — or the same against a quotation. State held in
     * the panel is thrown away by the main tab bar's ternary and lands them
     * back on the bill every time.
     */
    await open('Preview');
    await flipTo('A4 documents');

    for (const t of ['Branding', 'Preview']) {
      await act(async () => {
        screen.getByRole('button', { name: t }).click();
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    expect(within(visiblePanel()).getByLabelText('Document type')).toBeTruthy();
    expect(within(visiblePanel()).queryByTitle('Bill preview')).toBeNull();
  });

  it('a hardware workspace gets no toggle, because it previews one document', async () => {
    businessType = 'HARDWARE';
    await open('Preview');

    // NEGATIVE — no segmented control at all. A toggle with one option is a
    // dead control, which is what D96 exists to remove.
    expect(screen.queryAllByRole('tab')).toEqual([]);
    // POSITIVE — and hardware's own A4 preview is untouched, so this cannot
    // pass because the Preview tab rendered nothing.
    expect(screen.getByLabelText('Document type')).toBeTruthy();
  });

  it('a restaurant gets no toggle either, and keeps its bill', async () => {
    businessType = 'RESTAURANT';
    await open('Preview');

    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.getByTitle('Bill preview')).toBeTruthy();
  });
});
