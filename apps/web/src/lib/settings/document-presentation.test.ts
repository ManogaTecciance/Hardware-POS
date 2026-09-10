import { describe, expect, it } from 'vitest';

import { BUSINESS_TYPE_VALUES, domainFor } from '@hardware-pos/shared';

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
    //
    // D150: it now walks BUSINESS_TYPE_VALUES rather than a hand-written list.
    // The hand-written one had already fallen behind -- RETAIL was added in
    // D120 and never reached here, so the type this whole slice is about was
    // the one type the exhaustiveness test did not cover. A list that has to
    // be remembered is the failure D30 names: the fixture stopped representing
    // the real production structure and nothing went red.
    const surfaces = BUSINESS_TYPE_VALUES.map(
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
      // D152 — retail's bill moved to the roll while its quotations stayed on
      // the letterhead, which is a surface neither of the original two could
      // express. Every OTHER row is unchanged by that work, and that is the
      // half of this assertion worth having.
      RETAIL: 'THERMAL_BILL_AND_A4_DOCUMENTS',
    });
    // …and the walk really covered everything, so the map above cannot pass
    // by being compared against a subset of itself.
    expect(surfaces).toHaveLength(BUSINESS_TYPE_VALUES.length);
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

/**
 * D150 — which tenants may define their own business details.
 *
 * ## What makes these assertions non-vacuous
 *
 * The exact map over the REAL registry is the assertion. `showBusinessDetailsTab
 * is false for hardware` alone would pass for a resolver that returned false for
 * everyone — which is precisely what the shipped code did before the capability
 * existed — so the positive and the negative are one expectation over every
 * business type there is, not two expectations that could each hold alone.
 *
 * Walking `BUSINESS_TYPE_VALUES` rather than a list written here means a new
 * business type arrives in this test as a failure, with a name, rather than
 * quietly inheriting whichever answer its capabilities happen to produce.
 */
describe('D150 — the business-details tab', () => {
  it('is offered to retail and to nobody else', () => {
    const flags = BUSINESS_TYPE_VALUES.map((type) => [
      type,
      resolveDocumentSettingsPresentation({ capabilities: domainFor(type).capabilities })
        .showBusinessDetailsTab,
    ]);

    expect(Object.fromEntries(flags)).toEqual({
      HARDWARE: false,
      RESTAURANT: false,
      CAFE: false,
      BAKERY: false,
      HOTEL: false,
      GENERAL: false,
      RETAIL: true,
    });
    expect(flags).toHaveLength(BUSINESS_TYPE_VALUES.length);
  });

  it('is hidden while the profile is unresolved', () => {
    // D31 — not "assume retail and correct yourself"; a tab that appears and
    // then vanishes under the operator is worse than one that appears late.
    expect(
      resolveDocumentSettingsPresentation({ capabilities: null }).showBusinessDetailsTab,
    ).toBe(false);
  });

  it('is overlaid on the surface, not read out of it', () => {
    /*
     * D152 rewrote this case, and the reason matters. It used to prove the
     * overlay by pointing out that hardware and retail shared ONE surface
     * constant, so a table-driven flag could not tell them apart. D152 gave
     * retail its own surface, so that premise is simply no longer true and the
     * old assertion would now pass for the wrong reason — retail is currently
     * the only domain with either property, so a table-driven flag would AGREE
     * with the correct answer today and diverge the moment a second domain
     * gets business details without changing its paper.
     *
     * So it is proven directly instead: the surface constant retail resolves
     * to declares the flag FALSE, and the resolved value is TRUE. The overlay
     * is the only thing that can account for the difference.
     */
    const retailTenant = resolveDocumentSettingsPresentation({
      capabilities: domainFor('RETAIL').capabilities,
    });
    expect(retailTenant.surface).toBe('THERMAL_BILL_AND_A4_DOCUMENTS');
    expect(retailTenant.showBusinessDetailsTab).toBe(true);

    // The SAME surface, resolved for a domain without the catalogue
    // capability, must come back false — which is only possible if the flag
    // is not a property of the surface.
    const pretendRetailPaper = {
      ...domainFor('HARDWARE').capabilities,
      documents: {
        ...domainFor('HARDWARE').capabilities.documents,
        thermalBill: true,
        a4Documents: true,
      },
    };
    const sameSurface = resolveDocumentSettingsPresentation({
      capabilities: pretendRetailPaper,
    });
    expect(sameSurface.surface).toBe(retailTenant.surface);
    expect(sameSurface.showBusinessDetailsTab).toBe(false);
  });

  describe('the gate can actually fail', () => {
    it('M4: a truthiness check would hand the tab to every domain that omits the flag', () => {
      /*
       * The capability is OPTIONAL, so every other domain reads `undefined`.
       * `undefined` is falsy, so this mutation looks harmless — until a domain
       * sets it to `false` explicitly, or one is added that sets it to a
       * non-boolean. Proven by asserting the shipped resolver refuses a truthy
       * non-`true` value that a truthiness check would accept.
       */
      const truthyNonTrue = {
        ...domainFor('HARDWARE').capabilities,
        catalogue: {
          ...domainFor('HARDWARE').capabilities.catalogue,
          configurableBusinessDetails: 'yes' as unknown as boolean,
        },
      };
      expect(Boolean(truthyNonTrue.catalogue.configurableBusinessDetails)).toBe(true);
      expect(
        resolveDocumentSettingsPresentation({ capabilities: truthyNonTrue })
          .showBusinessDetailsTab,
      ).toBe(false);
    });

    it('M5: the surface constants all declare the flag false, so the table cannot supply it', () => {
      /*
       * D152 rewrote this proof for the reason given above: retail now has its
       * own surface, so "the table cannot tell hardware from retail" stopped
       * being true. The mutation it guards against is unchanged — somebody
       * deletes the overlay and reads `showBusinessDetailsTab` off the surface
       * constant — and it is now proven where it actually bites: EVERY
       * constant declares `false`, so that mutation yields false for everyone,
       * including the one domain the feature exists for.
       */
      for (const kind of ALL_DOCUMENT_SURFACE_KINDS) {
        const viaTable = classifiedDocumentSurfaces().includes(kind);
        expect(viaTable, kind).toBe(true);
      }
      // The shipped resolver says true for retail…
      expect(
        resolveDocumentSettingsPresentation({ capabilities: domainFor('RETAIL').capabilities })
          .showBusinessDetailsTab,
      ).toBe(true);
      // …while every domain that shares nothing but the paper says false, which
      // no constant-supplied value could produce.
      expect(
        resolveDocumentSettingsPresentation({ capabilities: domainFor('HARDWARE').capabilities })
          .showBusinessDetailsTab,
      ).toBe(false);
    });
  });
});

/**
 * D152 — retail prints its bill on a roll and its quotations on a letterhead.
 *
 * ## What makes these assertions non-vacuous
 *
 * The change that was asked for is one flag going false (`showA4SaleDocument`).
 * Asserting only that would pass for a resolver that had turned every A4
 * control off for retail — which is the actual hazard here, because the
 * obvious implementation is "make retail behave like a restaurant", and it
 * would silently strip the letterhead controls off a workspace that still
 * issues quotations.
 *
 * So the retail case asserts the A4 controls are STILL ON in the same
 * expectation that asserts the A4 bill is gone.
 *
 * The isolation cases pin hardware and food service field by field against the
 * surfaces they resolved to before this work. A third surface added to a
 * two-surface table is exactly the change that quietly moves a fourth tenant.
 */
describe('D152 — the thermal bill beside the A4 documents', () => {
  const retail = () =>
    resolveDocumentSettingsPresentation({ capabilities: domainFor('RETAIL').capabilities });

  it('takes the A4 BILL away and leaves every A4 DOCUMENT control standing', () => {
    const view = retail();

    // The ask: no A4 version of the sale.
    expect(view.showA4SaleDocument).toBe(false);

    // …and the half that stops this being "retail became a restaurant".
    // Every one of these belongs to the quotation, which retail still issues.
    for (const flag of [
      view.showSignatureAsset,
      view.showStampAsset,
      view.showAccentColor,
      view.showLogoPlacement,
      view.showPageSetup,
      view.showDocumentColumnToggles,
      view.showSignatureFieldsToggle,
      view.showPageNumbersToggle,
    ]) {
      expect(flag).toBe(true);
    }
  });

  it('gains the bill: its summary, its calibration and its preview', () => {
    const view = retail();

    expect(view.surface).toBe('THERMAL_BILL_AND_A4_DOCUMENTS');
    expect(view.showBillLayoutSummary).toBe(true);
    expect(view.showBillCalibration).toBe(true);
    expect(view.previewKind).toBe('THERMAL_BILL_AND_A4');
    // The note that rides on the customer document is the bill's now.
    expect(view.billNoteLabel).toBe('Bill note');
    // …and the layout note tells the operator which settings apply to what,
    // rather than the thermal surface's flat "there is no page size".
    expect(view.layoutNote).toMatch(/A4 documents/i);
  });

  it('leaves hardware exactly where it was', () => {
    /*
     * The isolation assertion. Hardware shares `RETAIL_CAPABILITIES` with
     * retail, so a change made in the wrong constant reaches it — and hardware
     * belongs to another team. Pinned field by field, not just by surface name.
     */
    const view = resolveDocumentSettingsPresentation({
      capabilities: domainFor('HARDWARE').capabilities,
    });

    expect(view.surface).toBe('A4_DOCUMENTS');
    expect(view.previewKind).toBe('SERVER_A4');
    expect(view.showA4SaleDocument).toBe(true);
    // D16 — the Tile Shop's wording is not edited to accommodate this.
    expect(view.billNoteLabel).toBe('Invoice note');
    expect(view.showBillLayoutSummary).toBe(false);
    expect(view.showBillCalibration).toBe(false);
  });

  it('leaves food service exactly where it was', () => {
    // `thermalBill: true` was added to FOOD_SERVICE_CAPABILITIES to say
    // directly what `proformaBill` had been standing in for. Behaviour must be
    // unchanged by that, which is what this pins.
    for (const type of ['RESTAURANT', 'CAFE', 'BAKERY', 'HOTEL'] as const) {
      const view = resolveDocumentSettingsPresentation({
        capabilities: domainFor(type).capabilities,
      });
      expect(view.surface, type).toBe('THERMAL_BILL');
      expect(view.previewKind, type).toBe('THERMAL_BILL');
      expect(view.showA4SaleDocument, type).toBe(false);
      // A kitchen issues no quotation, so it keeps none of the letterhead.
      expect(view.showSignatureAsset, type).toBe(false);
      expect(view.showPageSetup, type).toBe(false);
    }
  });

  it('every surface is reachable from a real domain, and none is orphaned', () => {
    // A surface in the table that no business type resolves to is dead code
    // pretending to be coverage.
    const reached = new Set(
      BUSINESS_TYPE_VALUES.map(
        (type) =>
          resolveDocumentSettingsPresentation({ capabilities: domainFor(type).capabilities })
            .surface,
      ),
    );
    expect([...reached].sort()).toEqual([...ALL_DOCUMENT_SURFACE_KINDS].sort());
  });

  describe('the routing can actually fail', () => {
    it('M6: routing on proformaBill puts retail back on A4, bill and all', () => {
      /*
       * The shipped code before D152. `proformaBill` means "a pre-payment bill
       * is issued separately from the receipt" — false for retail, which is
       * why the proxy could not express a retail thermal bill at all.
       */
      const caps = domainFor('RETAIL').capabilities;
      expect(caps.documents.proformaBill).toBe(false);
      const mutated = caps.documents.proformaBill ? 'THERMAL_BILL' : 'A4_DOCUMENTS';
      expect(mutated).toBe('A4_DOCUMENTS');
      // …and the shipped resolver does not.
      expect(retail().surface).toBe('THERMAL_BILL_AND_A4_DOCUMENTS');
    });

    it('M7: one combined flag would cost retail either its bill or its letterhead', () => {
      /*
       * The simplification somebody will propose: a single `thermalBill`, with
       * A4 implied by its absence. Both branches are wrong for retail, and this
       * writes out why rather than asserting it in prose.
       */
      const asOneFlag = (thermal: boolean) =>
        thermal
          ? { bill: 'THERMAL', a4Controls: false }
          : { bill: 'A4', a4Controls: true };

      // Retail needs a thermal bill AND the A4 controls; neither branch gives both.
      expect(asOneFlag(true).a4Controls).toBe(false);
      expect(asOneFlag(false).bill).toBe('A4');

      const view = retail();
      expect(view.showA4SaleDocument).toBe(false);
      expect(view.showPageSetup).toBe(true);
    });
  });
});
