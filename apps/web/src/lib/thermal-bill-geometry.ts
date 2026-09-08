import type { DocumentProfile } from './document-template-service';

/**
 * D99 — the printed bill's paper geometry, resolved in ONE place.
 *
 * ## Why this is a module and not three constants
 *
 * D73 through D80 is seven rounds of guessing these numbers, each measured
 * against one driver and — it turns out — one browser. The bill printed
 * correctly from Chrome and lost its left-hand characters from Edge on the
 * same till, because `body{padding:0 6mm 0 0}` put every millimetre of safety
 * on the RIGHT and bet the left edge on the browser landing the page box
 * exactly on the paper's printable origin. Chrome does. Edge re-fits and
 * centres the 78mm box on the driver's 78.7mm stock, which splits the overflow
 * between both edges — so an edge with no slack is an edge that loses ink.
 *
 * The defect was never the VALUE of the inset. It was that all the slack was
 * on one side, and that the number lived in source, where nobody can measure
 * it. An eighth constant would be the same bet with a different number.
 *
 * ## The layout width is the PAGE width, and that is not the obvious answer
 *
 * The tempting "fix" is to lay the print frame out at the CONTENT width. It is
 * wrong, and wrong silently. The body is `border-box` at `width:100%`, so a
 * frame 295px wide already gives a content column of 295px − 6mm = 272px —
 * exactly what a 78mm page with the same padding prints. Narrowing the frame
 * to the content width would subtract the insets a SECOND time, wrap more
 * lines, and over-measure the page height that gets written into `@page`.
 *
 * So the frame takes `pageWidthPx`. `contentWidthMm` is here for the
 * calibration strip, which has to talk about the column in millimetres.
 */

export interface BillGeometry {
  /** The driver's stock width; the page box, so nothing is ever centred. */
  pageWidthMm: number;
  leftInsetMm: number;
  rightInsetMm: number;
  /** Derived: the column the text occupies, in mm. */
  contentWidthMm: number;
  /** Derived: the LAYOUT width for the print frame and the preview, in CSS px. */
  pageWidthPx: number;
  /** D77 — one page sized to the content, for a driver set to a roll. */
  fitToContent: boolean;
}

/**
 * The only place 25.4 appears in the web app, and a contract test keeps it
 * that way: a second mm-to-px conversion is a second source of truth, and the
 * page height is measured in one unit and declared in the other.
 */
export function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

/** 96 CSS px = 1 inch = 25.4 mm. */
export function pxToMm(px: number): number {
  return (px / 96) * 25.4;
}

/**
 * Added past the measured content so the cutter does not shave the last line;
 * a receipt cut flush against its footer looks torn.
 *
 * It lives here rather than as a literal inside `fitPageToContent` because
 * `pageHeightMm` needs it twice — once for the content and once for the floor.
 */
export const CUTTER_MARGIN_MM = 2;

/**
 * D102 — the page height to declare, and the one rule it must obey: **a page is
 * never wider than it is tall.**
 *
 * `@page { size: W H }` has no separate orientation property. The two lengths
 * ARE the orientation, so a page box whose width exceeds its height is a
 * LANDSCAPE page and the print pipeline rotates it. Nothing used to bound this
 * number, and a bill short enough to fall under the paper's own width printed
 * sideways on the roll: clear every header field and the logo, print one item,
 * and the content came to about 180px — a 78mm x 50mm page.
 *
 * The floor is the paper width plus the cutter margin, so it tracks whatever
 * roll the workspace calibrated rather than being another 78. It is strictly
 * greater than the width, never equal: a square page is the ambiguous case and
 * there is no reason to hand a driver one.
 *
 * The cost is bounded and was chosen deliberately — a very short receipt gets
 * up to ~30mm of blank paper before the cut, and that disappears the moment the
 * bill has a header or a second line.
 *
 * This does not touch D77's position. Every height failure that record names is
 * a height too LARGE — 432mm and 223mm, scaled down by a driver that could not
 * honour them. This is the opposite end of the same axis, which D77 never had
 * cause to consider.
 */
export function pageHeightMm(g: BillGeometry, contentHeightPx: number): number {
  const measured = Math.ceil(pxToMm(contentHeightPx)) + CUTTER_MARGIN_MM;
  return Math.max(measured, g.pageWidthMm + CUTTER_MARGIN_MM);
}

/**
 * The Xprinter XP-365B this ships against: stock "USER", Maximum Size 78.7mm
 * wide, with the head stopping about 3.5mm short of the right edge (D80).
 *
 * The right inset stays the larger of the two because that asymmetry is real
 * and was measured off paper. The left is 3mm rather than 0 because a browser
 * that re-fits the page needs somewhere to take the overflow from, and at 0 it
 * takes it out of the first character.
 */
export const DEFAULT_BILL_GEOMETRY = {
  pageWidthMm: 78,
  leftInsetMm: 3,
  rightInsetMm: 5,
  fitToContent: true,
} as const;

/**
 * The same bounds the API DTO validates. Duplicated deliberately, and the
 * duplication is tested: the web app renders from a profile cached in
 * localStorage that never passed through the DTO, and a `Json` settings blob
 * can hold whatever an older client wrote into it.
 */
export const BILL_GEOMETRY_LIMITS = {
  /** Below 40mm is not a receipt roll; above 120mm is not a thermal one. */
  pageWidthMm: { min: 40, max: 120 },
  insetMm: { min: 0, max: 20 },
  /**
   * The narrowest column a bill is still readable in. Below this the AMOUNT
   * column has nowhere to go and every line wraps.
   */
  minContentMm: 20,
} as const;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve the geometry for a document profile.
 *
 * Every out-of-range value falls back to the DEFAULT rather than being clamped
 * to the nearest bound: a page width of 500mm is not a request for 120mm, it
 * is a corrupt setting, and quietly printing 120mm of bill would hide that.
 *
 * `contentWidthMm > 0` is a post-condition — an operator who types 20 and 20
 * on a 58mm roll would otherwise print a vertical column of single letters.
 */
export function resolveBillGeometry(
  profile: Partial<DocumentProfile> | null | undefined,
): BillGeometry {
  const d = DEFAULT_BILL_GEOMETRY;
  const limits = BILL_GEOMETRY_LIMITS;
  const p = profile ?? {};

  let pageWidthMm = num(p.billPaperWidthMm, d.pageWidthMm);
  let leftInsetMm = num(p.billLeftInsetMm, d.leftInsetMm);
  let rightInsetMm = num(p.billRightInsetMm, d.rightInsetMm);

  if (pageWidthMm < limits.pageWidthMm.min || pageWidthMm > limits.pageWidthMm.max) {
    pageWidthMm = d.pageWidthMm;
  }
  if (leftInsetMm < limits.insetMm.min || leftInsetMm > limits.insetMm.max) {
    leftInsetMm = d.leftInsetMm;
  }
  if (rightInsetMm < limits.insetMm.min || rightInsetMm > limits.insetMm.max) {
    rightInsetMm = d.rightInsetMm;
  }

  /*
   * The insets are checked TOGETHER as well as separately: 20mm each is inside
   * the individual bound and leaves nothing to print on a 58mm roll.
   *
   * Reverting them is enough, and there is no second fallback for the page
   * because the bounds guarantee one is never needed:
   * `pageWidthMm.min - (default left + default right) >= minContentMm`, i.e.
   * 40 - 8 >= 20. A defensive branch for that would be code no test could
   * reach; `BILL_GEOMETRY_LIMITS` is asserted to keep the invariant true
   * instead, so changing a bound fails loudly rather than silently making this
   * unsound.
   */
  if (pageWidthMm - leftInsetMm - rightInsetMm < limits.minContentMm) {
    leftInsetMm = d.leftInsetMm;
    rightInsetMm = d.rightInsetMm;
  }

  return {
    pageWidthMm,
    leftInsetMm,
    rightInsetMm,
    contentWidthMm: pageWidthMm - leftInsetMm - rightInsetMm,
    pageWidthPx: mmToPx(pageWidthMm),
    fitToContent: typeof p.billFitToContent === 'boolean' ? p.billFitToContent : d.fitToContent,
  };
}

/**
 * The body declarations that carry the geometry. Shared with the calibration
 * strip, which has to lay out byte-for-byte like the bill or it is measuring
 * something else.
 *
 * `width:100%` — the body fills the page box. Nothing is centred, so there is
 * no band of white; this is D80's surviving positive.
 *
 * `max-width` at exactly the page width — new, and permissible at no other
 * value. When `@page{size}` is honoured it does nothing. When a browser
 * refuses the size and falls back to A4 or Letter, it keeps the column at the
 * roll's width instead of letting a monospace bill designed for 78mm spread
 * across 210mm and land past the last printable dot. The D79 band of white was
 * a max-width NARROWER than the page, plus centring; this is neither.
 *
 * `margin:0`, never `auto` — auto margins are what centre a capped column, and
 * centring is that band of white by another route.
 *
 * Padding in MILLIMETRES, on both sides. Millimetres because a px inset changes
 * physical size the moment a browser applies a scale factor, which is the
 * family this whole defect belongs to. Both sides because that is the fix. The
 * two are not equal: the right keeps more, because its clip is a measured
 * property of the print head where the left's is browser drift.
 */
export function billBodyGeometryCss(g: BillGeometry): string {
  return (
    `width:100%;max-width:${g.pageWidthMm}mm;margin:0;` +
    `padding:0 ${g.rightInsetMm}mm 0 ${g.leftInsetMm}mm`
  );
}

/*
 * The document describes its own geometry, and the printer reads it back.
 *
 * `printReceipt` is handed an HTML STRING by several call sites. Any of them
 * could pass a width that disagrees with the CSS inside the string it is
 * passing, and nothing would catch it. Putting the numbers in the document
 * removes the parameter altogether: whatever the template rendered is what the
 * frame lays out at, because the frame asks the document.
 */
export const GEOMETRY_META = {
  pageWidthMm: 'hpos:page-width-mm',
  leftInsetMm: 'hpos:left-inset-mm',
  rightInsetMm: 'hpos:right-inset-mm',
  fitToContent: 'hpos:fit-to-content',
} as const;

/** The `meta` tags that carry the geometry into the printed document. */
export function billGeometryMetaTags(g: BillGeometry): string {
  return (
    `<meta name="${GEOMETRY_META.pageWidthMm}" content="${g.pageWidthMm}">` +
    `<meta name="${GEOMETRY_META.leftInsetMm}" content="${g.leftInsetMm}">` +
    `<meta name="${GEOMETRY_META.rightInsetMm}" content="${g.rightInsetMm}">` +
    `<meta name="${GEOMETRY_META.fitToContent}" content="${g.fitToContent ? '1' : '0'}">`
  );
}

/**
 * Read the geometry back out of a written document.
 *
 * Returns null for a document that carries none — a retail receipt, a
 * quotation, a return, anything server-rendered. Those keep the behaviour they
 * have always had: the default frame width and no page size declared (D16).
 * Null too for a document object that cannot be queried at all, which is what
 * a hand-rolled test fake looks like.
 */
export function readBillGeometry(doc: Document | null | undefined): BillGeometry | null {
  if (!doc || typeof doc.querySelector !== 'function') return null;

  const read = (name: string): string | null =>
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;

  const raw = [
    read(GEOMETRY_META.pageWidthMm),
    read(GEOMETRY_META.leftInsetMm),
    read(GEOMETRY_META.rightInsetMm),
  ];
  /*
   * PRESENCE first, then finiteness. `Number(null)` is 0 and 0 is finite, so a
   * numeric check alone accepts a document carrying only the page width and
   * silently reports insets of zero — which is precisely the zero-slack layout
   * D99 exists to remove, reintroduced through the back door.
   *
   * All three or none: a half-written marker set is a bug, not a geometry, and
   * falling back to the default keeps it visible.
   */
  if (raw.some((v) => v === null || v.trim() === '')) return null;
  const [pageWidthMm, leftInsetMm, rightInsetMm] = raw.map(Number) as [number, number, number];
  if (![pageWidthMm, leftInsetMm, rightInsetMm].every((v) => Number.isFinite(v))) return null;
  if (pageWidthMm <= 0) return null;

  return {
    pageWidthMm,
    leftInsetMm,
    rightInsetMm,
    contentWidthMm: pageWidthMm - leftInsetMm - rightInsetMm,
    pageWidthPx: mmToPx(pageWidthMm),
    fitToContent: read(GEOMETRY_META.fitToContent) !== '0',
  };
}
