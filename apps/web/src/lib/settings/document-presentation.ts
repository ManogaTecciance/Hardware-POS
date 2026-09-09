import type { TenantCapabilities } from '@hardware-pos/shared';

/**
 * What the Settings screen shows, for the document this tenant actually prints.
 *
 * ## Why a resolver and not conditionals in JSX
 *
 * Settings is one 650-line page with six tab components, and the question
 * "does this tenant print on A4 or on an 80mm roll?" reaches nine of them. Left
 * as `profile?.capabilities…` comparisons that is nine places to forget, and
 * the one that is forgotten offers a restaurant a signature upload it can never
 * use — the same hazard `product-presentation.ts` exists for, in a second
 * screen. So the decision is taken here once and the tabs read flags. A
 * structural test enforces it: no settings component may name a capability, a
 * business type or an inventory mode itself.
 *
 * ## Why capabilities and not `businessType`
 *
 * D56 — business-type comparisons have exactly one home, the domain registry.
 * `documents.proformaBill` names the DOCUMENT rather than the service model,
 * which is the property this screen is actually about: a future takeaway-only
 * bakery prints a bill without ever seating anyone, and HOTEL inherits the
 * right answer through the food-service capability set rather than through a
 * list of business types somebody has to remember to extend. HOTEL is the value
 * the seven hand-written predicates D56 replaced had all independently
 * forgotten.
 *
 * ## Unresolved is its own state
 *
 * While the profile is loading, and after a failed request, every flag is
 * `false` and the preview is `NONE`. The screen shows no document chrome at all
 * rather than briefly showing a restaurant the A4 controls, or a retail tenant
 * a thermal preview, and correcting itself a moment later. D31.
 *
 * ## Hiding is usability, not security
 *
 * Nothing here decides what may be saved. `PUT /v1/settings` accepts the whole
 * document profile whatever the browser draws, and a field whose control is
 * hidden keeps whatever value it already had.
 */

/**
 * The document surface a tenant prints on.
 *
 * D140 added the third. It is not a midpoint between the other two: a retail
 * workspace prints its BILL on a roll and its QUOTATIONS on a letterhead, so
 * it needs the thermal bill's controls and the A4 document's controls at the
 * same time. Modelling that as "A4 with a thermal option" or "thermal with
 * extras" would make one of the two a second-class citizen on the screen.
 */
export type DocumentSurfaceKind =
  | 'A4_DOCUMENTS'
  | 'THERMAL_BILL'
  | 'THERMAL_BILL_AND_A4_DOCUMENTS';

/** …plus the state where we do not yet know. */
export type DocumentSurface = DocumentSurfaceKind | 'UNRESOLVED';

/**
 * D141 — whose goods the sample bill is filled with.
 *
 * Coarse on purpose. It names the kind of thing sold, not the business type:
 * a grocer and a clothing shop both want "a shop's basket" here, and the
 * preview is illustration, not behaviour. Anything finer would be a taxonomy
 * somebody has to maintain for a picture.
 */
export type BillSampleKind = 'FOOD_SERVICE' | 'RETAIL';

/** How the Preview tab renders. */
export type DocumentPreviewKind =
  | 'SERVER_A4'
  | 'THERMAL_BILL'
  /** D140 — both, stacked: the roll the till prints and the A4 it quotes on. */
  | 'THERMAL_BILL_AND_A4'
  | 'NONE';

export interface DocumentSettingsPresentation {
  surface: DocumentSurface;
  /** The Settings page header's description line. */
  headerDescription: string;

  // ── Business tab ───────────────────────────────────────────────────────
  billNoteLabel: string;
  billNoteHint: string;

  // ── Branding tab ───────────────────────────────────────────────────────
  showSignatureAsset: boolean;
  showStampAsset: boolean;
  showAccentColor: boolean;
  /** Logo alignment and size travel together; neither reaches a thermal bill. */
  showLogoPlacement: boolean;
  /** One line explaining what branding does here, or `null` to say nothing. */
  brandingNote: string | null;

  // ── Layout tab ─────────────────────────────────────────────────────────
  showPageSetup: boolean;
  showDocumentColumnToggles: boolean;
  showSignatureFieldsToggle: boolean;
  showPageNumbersToggle: boolean;
  /** The read-only "What prints on the bill" card. */
  showBillLayoutSummary: boolean;
  layoutNote: string | null;

  // ── Preview tab ────────────────────────────────────────────────────────
  previewKind: DocumentPreviewKind;
  /**
   * D99 — the roll-calibration fields and the test strip.
   *
   * On Preview rather than Layout, deliberately: calibration is a
   * measure → adjust → reprint loop, and putting the numbers on a different
   * tab from the button that prints the ruler adds a tab switch to every turn
   * of it. It is also the one item on Layout's list that a thermal bill DOES
   * have, so it would read as a contradiction of layoutNote sitting there.
   */
  showBillCalibration: boolean;
  /**
   * D141 — which sample the bill preview fills itself with.
   *
   * The sample is not decoration. An operator checks the preview to see
   * whether their logo is too wide, whether the note reads right, whether a
   * long product name wraps — and a bill full of somebody else's trade
   * answers none of that. A clothing shop previewing "Grilled Seer" beside a
   * service charge is being shown a restaurant's bill with their name on it.
   *
   * `null` where no bill is previewed at all.
   */
  billSampleKind: BillSampleKind | null;

  // ── Tabs that only apply to a food-service workspace ───────────────────
  /** Charges and Hours edit `RestaurantBranchConfig`, which retail has no row in. */
  showRestaurantOperationsTabs: boolean;

  // ── Tabs gated on a catalogue capability, not on the print surface ─────
  /**
   * D138 — "Business details": the tab where a tenant defines the extra
   * per-product fields its Add Product wizard collects.
   *
   * NOT a property of the surface, which is why the three constants below all
   * declare it `false` and the resolver overlays the real answer. Retail and
   * hardware both print A4 documents and land on the SAME surface constant, and
   * exactly one of them may configure its own fields. Reading it off the
   * surface would therefore give hardware the tab, and the server would then
   * refuse everything the operator did on it.
   */
  showBusinessDetailsTab: boolean;

  // ── Elsewhere: the sale detail's print controls ────────────────────────
  /** "Print A4 bill" — the document whose branding this tenant can configure. */
  showA4SaleDocument: boolean;
}

const A4_DOCUMENTS: DocumentSettingsPresentation = {
  surface: 'A4_DOCUMENTS',
  headerDescription:
    'Business letterhead, branding and A4 template settings applied to every quotation, invoice, bill and return.',
  billNoteLabel: 'Invoice note',
  billNoteHint:
    'Printed below the footer on invoices only — e.g. a return policy. Leave blank to hide.',
  showSignatureAsset: true,
  showStampAsset: true,
  showAccentColor: true,
  showLogoPlacement: true,
  brandingNote: null,
  showPageSetup: true,
  showDocumentColumnToggles: true,
  showSignatureFieldsToggle: true,
  showPageNumbersToggle: true,
  showBillLayoutSummary: false,
  layoutNote: null,
  previewKind: 'SERVER_A4',
  // An A4 sheet's geometry is the driver's; there is no roll to calibrate.
  showBillCalibration: false,
  // No bill is previewed here at all.
  billSampleKind: null,
  showRestaurantOperationsTabs: false,
  // Overlaid by the resolver -- see the interface.
  showBusinessDetailsTab: false,
  showA4SaleDocument: true,
};

const THERMAL_BILL: DocumentSettingsPresentation = {
  surface: 'THERMAL_BILL',
  headerDescription:
    'Business details and branding as they appear on the printed bill.',
  billNoteLabel: 'Bill note',
  billNoteHint: 'Printed on the bill, above the footer line.',
  /*
   * A signature block, a stamp, an accent colour and a logo position are all
   * properties of an A4 document. A thermal bill is 78mm of black on white
   * with a hard-centred logo — see `thermal-bill.ts`, which reads exactly seven
   * profile fields and none of these. Offering them here is offering settings
   * that change nothing.
   */
  showSignatureAsset: false,
  showStampAsset: false,
  showAccentColor: false,
  showLogoPlacement: false,
  brandingNote:
    'The logo prints centred at the top of the bill and replaces the business name, so a wide or faint logo is worth checking on the Preview tab.',
  showPageSetup: false,
  showDocumentColumnToggles: false,
  showSignatureFieldsToggle: false,
  showPageNumbersToggle: false,
  showBillLayoutSummary: true,
  layoutNote:
    'A bill prints on a continuous roll, so there is no page size, orientation or margin to set. The roll’s own width and edge insets are measured on the Preview tab. What the bill contains is fixed; what it says comes from Business and Branding.',
  previewKind: 'THERMAL_BILL',
  showBillCalibration: true,
  billSampleKind: 'FOOD_SERVICE',
  showRestaurantOperationsTabs: true,
  // Overlaid by the resolver -- see the interface.
  showBusinessDetailsTab: false,
  showA4SaleDocument: false,
};

/**
 * D140 — retail: the bill is a slip, the quotation is a letterhead.
 *
 * Every A4 control stays, because a quotation still carries a logo, an accent,
 * a signature block, a stamp, a page size and a column set — and the operator
 * who prints one has to be able to set them. What goes is the A4 BILL: the
 * sale document is the roll now, so offering a second, A4 version of the same
 * sale is offering two answers to one question.
 *
 * What it GAINS over `A4_DOCUMENTS` is the bill: the read-only summary of what
 * the slip contains, the roll calibration, and a preview of the thing the till
 * actually prints.
 */
const THERMAL_BILL_AND_A4_DOCUMENTS: DocumentSettingsPresentation = {
  surface: 'THERMAL_BILL_AND_A4_DOCUMENTS',
  headerDescription:
    'Branding and letterhead for your quotations and notes, and the layout of the printed bill.',
  // The sale document is the roll, so the note that rides on it is the bill's.
  billNoteLabel: 'Bill note',
  billNoteHint: 'Printed on the bill, above the footer line.',
  // Every one of these belongs to the quotation, which retail still issues.
  showSignatureAsset: true,
  showStampAsset: true,
  showAccentColor: true,
  showLogoPlacement: true,
  brandingNote:
    'The logo appears on your A4 quotations where you place it, and centred at the top of the printed bill, where it replaces the business name — so a wide or faint logo is worth checking on the Preview tab.',
  showPageSetup: true,
  showDocumentColumnToggles: true,
  showSignatureFieldsToggle: true,
  showPageNumbersToggle: true,
  // …and this is what the surface adds: the bill has no settings of its own,
  // so the summary is how an operator learns what it contains.
  showBillLayoutSummary: true,
  layoutNote:
    'The settings above apply to your A4 documents. The printed bill has no page size or margins — it runs on a continuous roll, whose width and edge insets are measured on the Preview tab, and what it contains is fixed.',
  previewKind: 'THERMAL_BILL_AND_A4',
  showBillCalibration: true,
  billSampleKind: 'RETAIL',
  showRestaurantOperationsTabs: false,
  // Overlaid by the resolver -- see the interface.
  showBusinessDetailsTab: false,
  // D140 — the point of the whole surface: no A4 bill.
  showA4SaleDocument: false,
};

/**
 * Nothing drawn until the profile answers.
 *
 * Every flag false, and `previewKind: 'NONE'` rather than either real value —
 * defaulting to A4 would flash quotation chrome at a restaurant on every load,
 * which is the specific failure D31 names.
 */
const UNRESOLVED: DocumentSettingsPresentation = {
  surface: 'UNRESOLVED',
  headerDescription: 'Business letterhead and branding.',
  billNoteLabel: 'Bill note',
  billNoteHint: '',
  showSignatureAsset: false,
  showStampAsset: false,
  showAccentColor: false,
  showLogoPlacement: false,
  brandingNote: null,
  showPageSetup: false,
  showDocumentColumnToggles: false,
  showSignatureFieldsToggle: false,
  showPageNumbersToggle: false,
  showBillLayoutSummary: false,
  layoutNote: null,
  previewKind: 'NONE',
  showBillCalibration: false,
  billSampleKind: null,
  showRestaurantOperationsTabs: false,
  // Overlaid by the resolver -- see the interface.
  showBusinessDetailsTab: false,
  showA4SaleDocument: false,
};

/**
 * Keyed by a Record over the non-null union so that adding a surface is a
 * compile error here rather than a silent fallthrough at a call site.
 */
const CLASSIFICATION: Record<DocumentSurfaceKind, DocumentSettingsPresentation> = {
  A4_DOCUMENTS,
  THERMAL_BILL,
  THERMAL_BILL_AND_A4_DOCUMENTS,
};

/** Every surface, for a spec that wants to walk the whole space. */
export const ALL_DOCUMENT_SURFACE_KINDS: readonly DocumentSurfaceKind[] = [
  'A4_DOCUMENTS',
  'THERMAL_BILL',
  'THERMAL_BILL_AND_A4_DOCUMENTS',
];

/** The surfaces the classification actually answers for. */
export function classifiedDocumentSurfaces(): DocumentSurfaceKind[] {
  return Object.keys(CLASSIFICATION) as DocumentSurfaceKind[];
}

export interface DocumentSettingsPresentationInput {
  /** From `GET /v1/platform/profile`. `null` while unresolved, or after a failure. */
  capabilities: TenantCapabilities | null;
}

export function resolveDocumentSettingsPresentation(
  input: DocumentSettingsPresentationInput,
): DocumentSettingsPresentation {
  if (input.capabilities === null) return UNRESOLVED;
  const surface = CLASSIFICATION[documentSurfaceFor(input.capabilities)];
  return {
    ...surface,
    /*
     * D138 -- overlaid rather than table-driven, because it does not vary with
     * the print surface. `=== true` and not a truthiness check: the capability
     * is OPTIONAL on `catalogue`, so every domain that has not opted in reads
     * `undefined`, and `undefined` must mean "no tab", not "unknown".
     */
    showBusinessDetailsTab:
      input.capabilities.catalogue.configurableBusinessDetails === true,
  };
}

/**
 * D140 — the surface, from the two facts that decide it.
 *
 * Until D140 this read `documents.proformaBill`, which means "a pre-payment
 * bill is issued separately from the receipt" — a food-service fact that
 * happened to correlate with 80mm paper. It could not answer for retail, whose
 * bill is a slip and which issues no proforma at all. Asking the paper question
 * directly is what lets the third surface exist.
 *
 * `=== true` on both: they are OPTIONAL capabilities, so a domain that has not
 * opted in reads `undefined`, and `undefined` must mean "no" rather than
 * "unknown".
 *
 * Neither flag set falls back to `A4_DOCUMENTS`. No domain is in that state
 * today; it is the answer the screen gave before D140 for every domain that
 * was not food service, so a future descriptor that forgets both lands where
 * it would have landed rather than somewhere new.
 */
function documentSurfaceFor(capabilities: TenantCapabilities): DocumentSurfaceKind {
  const thermalBill = capabilities.documents.thermalBill === true;
  const a4Documents = capabilities.documents.a4Documents === true;
  if (thermalBill && a4Documents) return 'THERMAL_BILL_AND_A4_DOCUMENTS';
  if (thermalBill) return 'THERMAL_BILL';
  return 'A4_DOCUMENTS';
}
