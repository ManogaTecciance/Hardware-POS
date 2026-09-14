/**
 * D162 — the Inventory tab bar, per workspace.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * `product-presentation.test.ts` already proves the FLAGS are right for every
 * business type. That proves nothing about the bar: a component that ignored
 * the resolver entirely would pass all of it. This renders the REAL component
 * and reads the tabs off the screen.
 *
 * Every case asserts the WHOLE tab sequence, not just the absence of one label.
 * "Restaurant has no Barcodes tab" would hold for a bar that rendered nothing
 * at all — and rendering nothing is a plausible bug here, since both
 * capabilities are optional and a missing declaration reads as `undefined`.
 * Asserting the exact list in order catches that, and catches a tab quietly
 * lost from the four that are never gated.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUSINESS_TYPE_VALUES, type BusinessType } from '@hardware-pos/shared';

import { InventoryTabs } from './inventory-tabs';

/** Read inside the hoisted `vi.mock` factory, so each case can set it. */
let businessType: BusinessType | null = 'RETAIL';

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

vi.mock('next/navigation', () => ({ usePathname: () => '/products' }));

/*
 * The REAL registry decides, via the real resolver. A hand-written capability
 * object here would let this pass while `capabilities.ts` said something else,
 * which is the drift D56 exists to prevent.
 */
vi.mock('@/lib/platform-profile', () => ({
  useEffectiveProfile: () => ({
    status: businessType === null ? 'loading' : 'ready',
    profile: businessType === null ? null : { businessType },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

/** Every tab on screen, in order, however it is rendered. */
function tabsFor(type: BusinessType | null): string[] {
  businessType = type;
  render(<InventoryTabs />);
  const labels = screen
    .getAllByRole('tab', { hidden: true })
    .map((el) => el.textContent?.trim() ?? '');
  cleanup();
  return labels;
}

/** What every workspace sees regardless of business type. */
const ALWAYS = ['Products', 'Categories', 'Promotions'];
/** The placeholder pair that closes the bar, disabled since D45. */
const PLACEHOLDERS = ['Stock', 'Purchases'];

afterEach(cleanup);

describe('D162 — which catalogue tabs a workspace is shown', () => {
  it('retail keeps the full bar, exactly as it was', () => {
    // The PO was explicit: retail is unchanged. Asserted as the whole sequence
    // so a tab lost anywhere in it fails here, not just the two that are gated.
    expect(tabsFor('RETAIL')).toEqual([
      ...ALWAYS,
      'Attributes',
      'Barcodes',
      ...PLACEHOLDERS,
    ]);
  });

  it('hardware loses Attributes and keeps Barcodes', () => {
    expect(tabsFor('HARDWARE')).toEqual([...ALWAYS, 'Barcodes', ...PLACEHOLDERS]);
  });

  it('a restaurant loses both', () => {
    expect(tabsFor('RESTAURANT')).toEqual([...ALWAYS, ...PLACEHOLDERS]);
  });

  it('and so do the other food-service workspaces, including a hotel', () => {
    // HOTEL shares FOOD_SERVICE_CAPABILITIES. Named explicitly because it is
    // the business type the seven hand-written predicates D56 replaced had all
    // independently forgotten.
    for (const type of ['CAFE', 'BAKERY', 'HOTEL'] as const) {
      expect(tabsFor(type), type).toEqual([...ALWAYS, ...PLACEHOLDERS]);
    }
  });

  it('shows neither while the profile is unresolved', () => {
    // D31 — the ungated four still render, so the bar is never blank.
    expect(tabsFor(null)).toEqual([...ALWAYS, ...PLACEHOLDERS]);
  });

  it('never drops a tab that is not gated', () => {
    /*
     * The half that stops every case above from passing against a bar that
     * rendered fewer and fewer tabs. Whatever the business type, the four
     * ungated entries are present and in order.
     */
    for (const type of BUSINESS_TYPE_VALUES) {
      const tabs = tabsFor(type);
      expect(tabs.slice(0, 3), type).toEqual(ALWAYS);
      expect(tabs.slice(-2), type).toEqual(PLACEHOLDERS);
    }
  });

  it('the gated tabs still link to their own routes when shown', () => {
    // A tab that renders but points nowhere would satisfy the label
    // assertions above while being useless.
    businessType = 'RETAIL';
    render(<InventoryTabs />);
    expect(screen.getByRole('tab', { name: 'Attributes' }).getAttribute('href')).toBe(
      '/products/attributes',
    );
    expect(screen.getByRole('tab', { name: 'Barcodes' }).getAttribute('href')).toBe(
      '/products/barcodes',
    );
  });

  it('M1: filtering on the wrong flag would swap the two tabs — mutation proof', () => {
    /*
     * D30 rule 5. The cases above rest on each tab being filtered by ITS own
     * flag. Swapping them still yields two tabs for retail and none for a
     * restaurant, so the retail and restaurant cases would both still pass —
     * only hardware tells them apart, which is what this proves.
     */
    const hardware = tabsFor('HARDWARE');
    expect(hardware).toContain('Barcodes');
    expect(hardware).not.toContain('Attributes');
  });
});
