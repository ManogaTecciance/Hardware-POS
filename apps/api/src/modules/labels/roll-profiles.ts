/**
 * Label roll geometry.
 *
 * Every measurement is millimetres of PHYSICAL media, converted to printer dots
 * at render time — so the same profile works on a 203 dpi or 300 dpi head.
 *
 * On multi-across media (2-up / 3-up) the printer's gap sensor tracks one ROW,
 * so a single ZPL label format describes a whole row and the individual
 * stickers are positioned inside it by x-offset. `columns` therefore means
 * "stickers per row", not "labels per feed".
 *
 * Values below are the nominal sizes quoted for each roll. Real media varies by
 * a millimetre or two between suppliers, which is why `gapX`, `margin*` and the
 * `offset*` nudges exist — they are calibration knobs, not constants to trust.
 */

export type RollKey = 'plain' | 'double' | 'triple';

export interface RollProfile {
  key: RollKey;
  label: string;
  /** Stickers per row across the web. */
  columns: number;
  /** One sticker, in millimetres. */
  stickerWidthMm: number;
  stickerHeightMm: number;
  /** Horizontal space between stickers on a row (0 for single-across). */
  gapXMm: number;
  /** Unprintable/left edge before the first sticker. */
  marginLeftMm: number;
  marginTopMm: number;
  /** Post-calibration nudges, applied to every field (may be negative). */
  offsetXMm: number;
  offsetYMm: number;
  /** How much of the sticker the barcode may occupy vertically. */
  barcodeHeightMm: number;
  /** Which optional fields fit at this size. */
  content: {
    productName: boolean;
    price: boolean;
    sku: boolean;
    /** Human-readable digits printed under the bars by the printer. */
    humanReadable: boolean;
  };
}

/** ZD888TA ships as a 203 dpi head; 300 dpi variants exist, hence configurable. */
export const DEFAULT_DPI = 203;

/** Widest the ZD888 can image (~4.09in). Used to catch impossible geometry. */
export const MAX_PRINT_WIDTH_MM = 104;

export const ROLL_PROFILES: Record<RollKey, RollProfile> = {
  plain: {
    key: 'plain',
    label: 'Plain (90 × 45mm, 1 across)',
    columns: 1,
    stickerWidthMm: 90,
    stickerHeightMm: 45,
    gapXMm: 0,
    marginLeftMm: 2,
    marginTopMm: 2,
    offsetXMm: 0,
    offsetYMm: 0,
    barcodeHeightMm: 18,
    content: { productName: true, price: true, sku: true, humanReadable: true },
  },
  double: {
    key: 'double',
    label: 'Double (50 × 25mm, 2 across)',
    columns: 2,
    stickerWidthMm: 50,
    stickerHeightMm: 25,
    gapXMm: 2,
    marginLeftMm: 1,
    marginTopMm: 1.5,
    offsetXMm: 0,
    offsetYMm: 0,
    barcodeHeightMm: 10,
    content: { productName: true, price: true, sku: false, humanReadable: true },
  },
  triple: {
    key: 'triple',
    label: 'Triple (30 × 20mm, 3 across)',
    columns: 3,
    stickerWidthMm: 30,
    stickerHeightMm: 20,
    gapXMm: 2,
    marginLeftMm: 1,
    marginTopMm: 1.5,
    offsetXMm: 0,
    offsetYMm: 0,
    barcodeHeightMm: 8,
    // 30 × 20mm only has room for the code itself.
    content: { productName: false, price: false, sku: true, humanReadable: false },
  },
};

/** Total media width a profile implies, including gaps and the left margin. */
export function webWidthMm(profile: RollProfile): number {
  const stickers = profile.columns * profile.stickerWidthMm;
  const gaps = (profile.columns - 1) * profile.gapXMm;
  return profile.marginLeftMm * 2 + stickers + gaps;
}

/** Millimetres → printer dots, rounded to a whole dot. */
export function mmToDots(mm: number, dpi: number = DEFAULT_DPI): number {
  return Math.round((mm * dpi) / 25.4);
}

export function getRollProfile(key: RollKey, overrides?: Partial<RollProfile>): RollProfile {
  const base = ROLL_PROFILES[key];
  if (!base) throw new Error(`Unknown roll profile "${key}"`);
  return overrides ? { ...base, ...overrides, content: { ...base.content, ...overrides.content } } : base;
}
