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

/** The document surface a tenant prints on. */
export type DocumentSurfaceKind = 'A4_DOCUMENTS' | 'THERMAL_BILL';

/** …plus the state where we do not yet know. */
export type DocumentSurface = DocumentSurfaceKind | 'UNRESOLVED';

/** How the Preview tab renders. */
export type DocumentPreviewKind = 'SERVER_A4' | 'THERMAL_BILL' | 'NONE';

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

  // ── Tabs that only apply to a food-service workspace ───────────────────
  /** Charges and Hours edit `RestaurantBranchConfig`, which retail has no row in. */
  showRestaurantOperationsTabs: boolean;

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
  showRestaurantOperationsTabs: false,
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
  showRestaurantOperationsTabs: true,
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
  showRestaurantOperationsTabs: false,
  showA4SaleDocument: false,
};

/**
 * Keyed by a Record over the non-null union so that adding a surface is a
 * compile error here rather than a silent fallthrough at a call site.
 */
const CLASSIFICATION: Record<DocumentSurfaceKind, DocumentSettingsPresentation> = {
  A4_DOCUMENTS,
  THERMAL_BILL,
};

/** Every surface, for a spec that wants to walk the whole space. */
export const ALL_DOCUMENT_SURFACE_KINDS: readonly DocumentSurfaceKind[] = [
  'A4_DOCUMENTS',
  'THERMAL_BILL',
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
  return CLASSIFICATION[
    input.capabilities.documents.proformaBill ? 'THERMAL_BILL' : 'A4_DOCUMENTS'
  ];
}
