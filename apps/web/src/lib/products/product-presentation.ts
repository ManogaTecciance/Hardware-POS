/**
 * How the product screens present themselves for one tenant's inventory mode.
 *
 * ## Why a resolver and not conditionals in JSX
 *
 * Slice 6C-B moved catalogue synchronisation behind a provider on the server so
 * `ProductsService` holds no profile conditional. The frontend has the same hazard
 * in a different form: `inventoryMode === 'QUICKBOOKS'` sprinkled through a table,
 * a detail page, a form and three wizard steps is nine places to forget, and the
 * one that is forgotten shows a LOCAL tenant a QuickBooks requirement that does not
 * apply to them.
 *
 * So every mode-dependent decision is taken here, once, and the components read
 * flags. A structural test enforces that: the product components may not name an
 * inventory mode themselves.
 *
 * ## What it is NOT allowed to do
 *
 * It never infers the mode. `syncStatus`, `quickbooksItemId`, the product name, the
 * business type and the presence of a QuickBooks connection are all incapable of
 * distinguishing "this tenant does not use QuickBooks" from "this tenant uses
 * QuickBooks and this product has not reached it yet". The mode arrives from
 * `GET /v1/platform/profile` and nowhere else; the two product fields are inputs to
 * *presentation within* a mode, never to the choice of mode.
 *
 * ## Hiding is usability, not security
 *
 * Every flag here only decides what is drawn. The server still resolves the tenant's
 * provider from the authenticated session and refuses a QuickBooks push for a LOCAL
 * or DISABLED tenant whatever the browser sends.
 */
import type { InventoryMode } from '@/lib/platform-api';

import type { ProductSyncStatus } from '@/lib/products-api';

/**
 * The presentation classes, which are deliberately NOT one-per-`InventoryMode`.
 *
 * `LOCAL` and `DISABLED` share "no external catalogue" but differ on whether stock
 * means anything, and that difference is the whole point of keeping them apart.
 */
export type ProductManagementMode =
  /** QuickBooks masters the catalogue. Today's Tile Shop screen, unchanged. */
  | 'EXTERNAL_CATALOGUE'
  /** AxloPOS masters the catalogue and tracks stock. */
  | 'LOCAL'
  /** AxloPOS masters the catalogue; stock is not tracked at all. */
  | 'CATALOGUE_ONLY'
  /** A configured provider with no implementation. Fails safe, offers nothing. */
  | 'UNSUPPORTED'
  /** The profile has not loaded, or the request for it failed. */
  | 'UNRESOLVED';

/** Badge styling, mapped to the existing `Badge` variants. */
export type ProductBadgeKind = 'success' | 'primary' | 'neutral' | 'warning' | 'danger';

export interface ProductPresentation {
  managementMode: ProductManagementMode;

  /**
   * The provider-neutral status label for one product.
   *
   * `null` in `EXTERNAL_CATALOGUE`, where {@link showSyncStatus} is true and the
   * existing `SyncBadge` owns the wording instead — that is what keeps the
   * QuickBooks screens byte-identical.
   */
  label: string | null;
  badgeKind: ProductBadgeKind;

  /** The "Source" column value, or `null` to omit the column entirely. */
  sourceLabel: string | null;
  /**
   * The longer form the detail page has always used for the same fact
   * (`QuickBooks-managed`, `Local (not synced)`), or `null` alongside
   * {@link sourceLabel}. Kept here rather than mapped in the page so the two
   * wordings cannot drift apart.
   */
  sourceDetailLabel: string | null;
  /** Styling for the source badge. Never `danger`/`warning` for a valid product. */
  sourceBadgeKind: ProductBadgeKind;

  /** Render the QuickBooks sync badge, column and filter. */
  showSyncStatus: boolean;
  /** Render "Sync to QuickBooks" / "Retry". */
  showSyncActions: boolean;
  /** Render "Refresh from QuickBooks". */
  showRefreshAction: boolean;
  /** Render quantity, reorder point and the stock filter. */
  showStockControls: boolean;
  /** Allow low/out-of-stock warning styling. Off when stock promises nothing. */
  showStockWarnings: boolean;
  /**
   * What to say in place of the stock figures when {@link showStockControls} is
   * off, or `null` to say nothing.
   *
   * `null` while unresolved is the point: "stock is not tracked" is a claim about
   * the tenant's configuration, and the UI must not make it before it knows.
   */
  stockTrackingNote: string | null;
  /** Render the read-only QuickBooks income/expense/asset account panel. */
  showExternalAccounts: boolean;

  /** One sentence describing where this tenant's products live. */
  helpText: string;
  /** Sub-heading for the form's identity step. */
  detailsHelpText: string;
  /** Sub-heading for the product-image panel. */
  imageHelpText: string;

  /**
   * Post-save wording, or `null` to keep the existing silent redirect.
   *
   * `null` for QuickBooks on purpose: adding a banner there would change a screen
   * this slice must leave alone.
   */
  saveMessage: string | null;

  /** A configuration problem the operator must be told about, if any. */
  warning: string | null;
}

/**
 * The inventory-mode-shaped input, widened with the one non-mode state the UI has.
 *
 * `null` means "not resolved yet, or the request failed" — never "assume the legacy
 * default". Guessing on the client is exactly how a LOCAL tenant would be shown
 * QuickBooks controls for the first few hundred milliseconds of every page load.
 */
export type ProfileInventoryState = InventoryMode | null;

interface ModeClassification {
  managementMode: ProductManagementMode;
  neutralLabel: string | null;
  badgeKind: ProductBadgeKind;
  sourceLabel: string | null;
  showSyncStatus: boolean;
  showSyncActions: boolean;
  showRefreshAction: boolean;
  showStockControls: boolean;
  showStockWarnings: boolean;
  stockTrackingNote: string | null;
  showExternalAccounts: boolean;
  helpText: string;
  detailsHelpText: string;
  imageHelpText: string;
  saveMessage: string | null;
  warning: string | null;
}

/**
 * Every `InventoryMode`, classified.
 *
 * A `Record` keyed by the union rather than a `switch` with a default, so adding a
 * member to `InventoryMode` is a **compile error here** until someone decides what
 * it looks like. There is no fallback branch that could quietly absorb it — and
 * `product-presentation.test.ts` cross-checks these keys against a runtime list so
 * the decision cannot be skipped by widening the type alone.
 */
const CLASSIFICATION: Record<Exclude<ProfileInventoryState, null>, ModeClassification> = {
  QUICKBOOKS: {
    managementMode: 'EXTERNAL_CATALOGUE',
    // Null: `SyncBadge` supplies the label, so the existing wording is not restated
    // here and therefore cannot drift from it.
    neutralLabel: null,
    badgeKind: 'primary',
    sourceLabel: 'QuickBooks',
    showSyncStatus: true,
    showSyncActions: true,
    showRefreshAction: true,
    showStockControls: true,
    showStockWarnings: true,
    stockTrackingNote: null,
    showExternalAccounts: true,
    helpText: 'Manage the product catalog. QuickBooks remains the inventory master.',
    detailsHelpText: 'The name, type, and category this product is filed under — mirroring QuickBooks.',
    imageHelpText: 'Shown on the POS tiles only — this photo is not sent to QuickBooks.',
    saveMessage: null,
    warning: null,
  },

  LOCAL: {
    managementMode: 'LOCAL',
    neutralLabel: 'Locally managed',
    // Neutral, never danger or warning. A local product with no QuickBooks item id
    // is complete and correct, and must not be styled as a problem.
    badgeKind: 'neutral',
    sourceLabel: 'Locally managed',
    showSyncStatus: false,
    showSyncActions: false,
    showRefreshAction: false,
    // Stock is real here — AxloPOS is the authority for it.
    showStockControls: true,
    showStockWarnings: true,
    stockTrackingNote: null,
    showExternalAccounts: false,
    helpText: 'Manage the product catalog. Products and stock are managed in AxloPOS.',
    detailsHelpText: 'The name, type, and category this product is filed under.',
    imageHelpText: 'Shown on the POS tiles.',
    saveMessage: 'Saved to AxloPOS.',
    warning: null,
  },

  DISABLED: {
    managementMode: 'CATALOGUE_ONLY',
    neutralLabel: 'Catalogue item',
    badgeKind: 'neutral',
    sourceLabel: 'Catalogue item',
    showSyncStatus: false,
    showSyncActions: false,
    showRefreshAction: false,
    // Off, so no quantity is presented as a promise of availability that nothing
    // enforces. The catalogue itself stays fully manageable.
    showStockControls: false,
    showStockWarnings: false,
    stockTrackingNote: 'Stock tracking disabled',
    showExternalAccounts: false,
    helpText: 'Manage the product catalog. Stock tracking is disabled for this business.',
    detailsHelpText: 'The name, type, and category this catalogue item is filed under.',
    imageHelpText: 'Shown on the POS tiles.',
    saveMessage: 'Saved to the catalogue.',
    warning: null,
  },

  EXTERNAL: {
    managementMode: 'UNSUPPORTED',
    neutralLabel: 'Not configured',
    badgeKind: 'warning',
    sourceLabel: null,
    // Everything off. Falling back to QuickBooks would push a tenant's catalogue
    // into a system they did not choose; falling back to Local would claim stock
    // authority AxloPOS does not have. Neither is safe, so it offers nothing.
    showSyncStatus: false,
    showSyncActions: false,
    showRefreshAction: false,
    showStockControls: false,
    showStockWarnings: false,
    stockTrackingNote: null,
    showExternalAccounts: false,
    helpText: 'External inventory provider is not configured.',
    detailsHelpText: 'The name, type, and category this product is filed under.',
    imageHelpText: 'Shown on the POS tiles.',
    saveMessage: null,
    warning: 'External inventory provider is not configured.',
  },
};

/**
 * The safe default while the profile is unknown.
 *
 * Shared by "still loading" and "the request failed", because the UI has the same
 * obligation in both: it does not know what this tenant uses, so it offers no
 * external action and claims no status. It still renders the catalogue, so the page
 * does not reflow when the profile lands.
 */
const UNRESOLVED: ModeClassification = {
  managementMode: 'UNRESOLVED',
  neutralLabel: 'Checking configuration…',
  badgeKind: 'neutral',
  sourceLabel: null,
  showSyncStatus: false,
  showSyncActions: false,
  showRefreshAction: false,
  // Stock is shown read-only: the quantity is a fact from the server either way,
  // and blanking the column would move the table's layout when the profile lands.
  showStockControls: false,
  showStockWarnings: false,
  stockTrackingNote: null,
  showExternalAccounts: false,
  helpText: 'Manage the product catalog.',
  detailsHelpText: 'The name, type, and category this product is filed under.',
  imageHelpText: 'Shown on the POS tiles.',
  saveMessage: null,
  warning: null,
};

export interface ProductPresentationInput {
  /** From `GET /v1/platform/profile`. `null` while unresolved or after a failure. */
  inventoryMode: ProfileInventoryState;
  /**
   * The product's persisted sync status. Legacy external-integration state — it is
   * read for display inside `EXTERNAL_CATALOGUE` and ignored everywhere else.
   * Omitted for a screen-level (not per-product) call.
   */
  syncStatus?: ProductSyncStatus;
  /** The product's QuickBooks item id, or `null`. Never used to infer the mode. */
  quickbooksItemId?: string | null;
}

/**
 * Resolve the product presentation for one tenant, and optionally one product.
 *
 * Pure: same input, same output, no clock, no network, no session. Call it with
 * just `inventoryMode` for screen-level questions ("is there a sync filter"), and
 * with the product fields for row-level ones ("what does this badge say").
 */
export function resolveProductManagementPresentation(
  input: ProductPresentationInput,
): ProductPresentation {
  const base = input.inventoryMode === null ? UNRESOLVED : CLASSIFICATION[input.inventoryMode];

  return {
    managementMode: base.managementMode,
    label: base.neutralLabel,
    badgeKind: base.badgeKind,
    sourceLabel: resolveSourceLabel(base, input.quickbooksItemId),
    sourceDetailLabel: resolveSourceDetailLabel(base, input.quickbooksItemId),
    sourceBadgeKind: resolveSourceBadgeKind(base, input.quickbooksItemId),
    showSyncStatus: base.showSyncStatus,
    showSyncActions: base.showSyncActions,
    showRefreshAction: base.showRefreshAction,
    showStockControls: base.showStockControls,
    showStockWarnings: base.showStockWarnings,
    stockTrackingNote: base.stockTrackingNote,
    showExternalAccounts: base.showExternalAccounts,
    helpText: base.helpText,
    detailsHelpText: base.detailsHelpText,
    imageHelpText: base.imageHelpText,
    saveMessage: base.saveMessage,
    warning: base.warning,
  };
}

/**
 * The "Source" cell.
 *
 * In `EXTERNAL_CATALOGUE` this keeps today's exact behaviour — `QuickBooks` for a
 * linked product, `Local` for one that has not reached QuickBooks yet — because
 * there the distinction is real and operators rely on it. In every other mode the
 * item id is irrelevant and the label is the mode's own.
 */
function resolveSourceLabel(
  base: ModeClassification,
  quickbooksItemId: string | null | undefined,
): string | null {
  if (base.managementMode !== 'EXTERNAL_CATALOGUE') return base.sourceLabel;
  if (quickbooksItemId === undefined) return base.sourceLabel;
  return quickbooksItemId ? 'QuickBooks' : 'Local';
}

/**
 * The detail page's phrasing of the same fact.
 *
 * `Local (not synced)` is retained **only** inside `EXTERNAL_CATALOGUE`, where it is
 * accurate — that product really is waiting to reach QuickBooks. In `LOCAL` the same
 * product is finished, so it says `Locally managed` and the phrase "not synced"
 * never appears.
 */
function resolveSourceDetailLabel(
  base: ModeClassification,
  quickbooksItemId: string | null | undefined,
): string | null {
  if (base.managementMode !== 'EXTERNAL_CATALOGUE') return base.sourceLabel;
  if (quickbooksItemId === undefined) return base.sourceLabel;
  return quickbooksItemId ? 'QuickBooks-managed' : 'Local (not synced)';
}

/**
 * The source badge's variant, preserving today's QuickBooks table exactly:
 * `primary` for a linked product, `neutral` for one that has not reached
 * QuickBooks yet. Outside that mode the item id means nothing, so the mode's own
 * neutral styling applies — a local product is never styled as an exception.
 */
function resolveSourceBadgeKind(
  base: ModeClassification,
  quickbooksItemId: string | null | undefined,
): ProductBadgeKind {
  if (base.managementMode !== 'EXTERNAL_CATALOGUE') return 'neutral';
  if (quickbooksItemId === undefined) return base.badgeKind;
  return quickbooksItemId ? 'primary' : 'neutral';
}

/**
 * Every `InventoryMode` the API can return, as runtime data.
 *
 * Exists so a test can walk the whole space instead of the members someone
 * remembered. Kept next to {@link CLASSIFICATION} on purpose: the spec asserts these
 * two agree exactly, so adding a mode to the type without listing it here — or
 * listing it without classifying it — fails.
 */
export const ALL_INVENTORY_MODES: readonly Exclude<ProfileInventoryState, null>[] = [
  'QUICKBOOKS',
  'LOCAL',
  'EXTERNAL',
  'DISABLED',
];

/** The classified modes, for the exhaustiveness spec. */
export function classifiedInventoryModes(): string[] {
  return Object.keys(CLASSIFICATION).sort();
}
