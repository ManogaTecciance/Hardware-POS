import { describe, expect, it } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

import {
  ALL_DOCUMENT_SURFACE_KINDS,
  classifiedDocumentSurfaces,
  resolveDocumentSettingsPresentation,
} from './document-presentation';

/**
 * D96 — which document Settings is about.
 *
 * The fixtures come from the REAL domain registry rather than hand-written
 * capability objects: a hand-written one asserts about itself, and the specific
 * failure this guards is a business type nobody remembered — HOTEL reuses the
 * food-service capability set, and it is the value the seven predicates D56
 * replaced had all independently forgotten.
 */

const retail = () => domainFor('HARDWARE').capabilities;
const restaurant = () => domainFor('RESTAURANT').capabilities;
const hotel = () => domainFor('HOTEL').capabilities;

describe('resolveDocumentSettingsPresentation', () => {
  it('a retail tenant keeps every A4 control, exactly as today', () => {
    const view = resolveDocumentSettingsPresentation({ capabilities: retail() });

    expect(view.surface).toBe('A4_DOCUMENTS');
    expect(view.previewKind).toBe('SERVER_A4');
    for (const flag of [
      view.showSignatureAsset,
      view.showStampAsset,
      view.showAccentColor,
      view.showLogoPlacement,
      view.showPageSetup,
      view.showDocumentColumnToggles,
      view.showSignatureFieldsToggle,
      view.showPageNumbersToggle,
      view.showA4SaleDocument,
    ]) {
      expect(flag).toBe(true);
    }
    // D16 — the Tile Shop's wording is not edited to accommodate this.
    expect(view.billNoteLabel).toBe('Invoice note');
    expect(view.billNoteHint).toBe(
      'Printed below the footer on invoices only — e.g. a return policy. Leave blank to hide.',
    );
    // NEGATIVE: retail gets neither the bill summary nor the restaurant tabs,
    // and no roll calibration — an A4 sheet's geometry is the driver's (D99).
    expect(view.showBillLayoutSummary).toBe(false);
    expect(view.showBillCalibration).toBe(false);
    expect(view.showRestaurantOperationsTabs).toBe(false);
  });

  it('a food-service tenant loses the quotation and invoice chrome', () => {
    const view = resolveDocumentSettingsPresentation({ capabilities: restaurant() });

    expect(view.surface).toBe('THERMAL_BILL');
    expect(view.previewKind).toBe('THERMAL_BILL');
    // The PO's list, named one by one so a re-added control is obvious.
    expect(view.showSignatureAsset).toBe(false); // Authorized signature
    expect(view.showStampAsset).toBe(false); // Company stamp / seal
    expect(view.showAccentColor).toBe(false);
    expect(view.showLogoPlacement).toBe(false);
    expect(view.showPageSetup).toBe(false);
    expect(view.showDocumentColumnToggles).toBe(false);
    expect(view.showSignatureFieldsToggle).toBe(false);
    expect(view.showPageNumbersToggle).toBe(false);
    // …and the A4 sale document goes with them: leaving it would hand a
    // restaurant a signature block it can no longer populate or switch off.
    expect(view.showA4SaleDocument).toBe(false);

    // POSITIVE, so the wall of `false` above cannot be an object of all-false:
    expect(view.showBillLayoutSummary).toBe(true);
    expect(view.showRestaurantOperationsTabs).toBe(true);
    // D99 — the roll is the one piece of page setup a thermal bill DOES have,
    // and it lives on Preview beside the strip that measures it.
    expect(view.showBillCalibration).toBe(true);
    expect(view.layoutNote).toMatch(/Preview tab/i);
    expect(view.billNoteLabel).toBe('Bill note');
    expect(view.brandingNote).toMatch(/logo/i);
    expect(view.layoutNote).toMatch(/continuous roll/i);
  });

  it('a hotel resolves like a restaurant, through the capability and not a list', () => {
    // The anti-vacuity guard. HOTEL is not named anywhere in the resolver; it
    // arrives via the food-service capability set. A resolver written as
    // `businessType === 'RESTAURANT'` passes every other test in this file and
    // fails this one.
    expect(hotel().documents.proformaBill).toBe(true);
    expect(resolveDocumentSettingsPresentation({ capabilities: hotel() }).surface).toBe(
      'THERMAL_BILL',
    );
  });

  it('unresolved draws no document chrome at all, and is not A4 by default', () => {
    const view = resolveDocumentSettingsPresentation({ capabilities: null });

    expect(view.surface).toBe('UNRESOLVED');
    expect(view.previewKind).toBe('NONE');
    for (const flag of [
      view.showSignatureAsset,
      view.showStampAsset,
      view.showAccentColor,
      view.showLogoPlacement,
      view.showPageSetup,
      view.showDocumentColumnToggles,
      view.showSignatureFieldsToggle,
      view.showPageNumbersToggle,
      view.showBillLayoutSummary,
      view.showRestaurantOperationsTabs,
      view.showA4SaleDocument,
      view.showBillCalibration,
    ]) {
      expect(flag).toBe(false);
    }
    // NEGATIVE, named: the failure mode is defaulting to the legacy config.
    expect(view.previewKind).not.toBe('SERVER_A4');
    expect(view.surface).not.toBe('A4_DOCUMENTS');
  });

  it('the classification answers for every surface, with none left over', () => {
    // D30 rule 3 — an exact SET, not a count. A surface added to the union and
    // forgotten in the Record is a runtime `undefined` at every call site.
    expect(classifiedDocumentSurfaces().sort()).toEqual([...ALL_DOCUMENT_SURFACE_KINDS].sort());
    expect(ALL_DOCUMENT_SURFACE_KINDS.length).toBeGreaterThan(1);
  });

  it('the registry drives it: every business type lands somewhere deliberate', () => {
    // Walks the real registry so a NEW business type shows up here rather than
    // silently taking whichever branch its capabilities happen to hit.
    const surfaces = (['HARDWARE', 'RESTAURANT', 'CAFE', 'BAKERY', 'HOTEL', 'GENERAL'] as const).map(
      (type) => [
        type,
        resolveDocumentSettingsPresentation({ capabilities: domainFor(type).capabilities }).surface,
      ],
    );

    expect(Object.fromEntries(surfaces)).toEqual({
      HARDWARE: 'A4_DOCUMENTS',
      RESTAURANT: 'THERMAL_BILL',
      CAFE: 'THERMAL_BILL',
      BAKERY: 'THERMAL_BILL',
      HOTEL: 'THERMAL_BILL',
      GENERAL: 'A4_DOCUMENTS',
    });
  });

  /*
   * MUTATION PROOFS (D30), against the real resolver.
   */
  describe('the routing can actually fail', () => {
    it('M1: routing on business type instead of the capability loses HOTEL', () => {
      const byType = (type: string) => (type === 'RESTAURANT' ? 'THERMAL_BILL' : 'A4_DOCUMENTS');
      expect(byType('HOTEL')).toBe('A4_DOCUMENTS');
      expect(resolveDocumentSettingsPresentation({ capabilities: hotel() }).surface).toBe(
        'THERMAL_BILL',
      );
    });

    it('M2: treating unresolved as retail flashes A4 chrome at a restaurant', () => {
      const shipped = resolveDocumentSettingsPresentation({ capabilities: null });
      const mutated = resolveDocumentSettingsPresentation({ capabilities: retail() });
      expect(shipped.showSignatureAsset).toBe(false);
      expect(mutated.showSignatureAsset).toBe(true);
      expect(shipped.previewKind).not.toBe(mutated.previewKind);
    });

    it('M3: inverting the capability test swaps both tenants', () => {
      const inverted = (caps: { documents: { proformaBill: boolean } }) =>
        caps.documents.proformaBill ? 'A4_DOCUMENTS' : 'THERMAL_BILL';
      expect(inverted(retail())).toBe('THERMAL_BILL');
      expect(resolveDocumentSettingsPresentation({ capabilities: retail() }).surface).toBe(
        'A4_DOCUMENTS',
      );
    });
  });
});
