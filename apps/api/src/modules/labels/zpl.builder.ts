import { CURRENCY_SYMBOL } from '@hardware-pos/shared';

import { mmToDots, webWidthMm, type RollProfile } from './roll-profiles';
import { chooseSymbology } from './symbology';

/**
 * ZPL II generation for product labels.
 *
 * Pure string building — no I/O, no printer knowledge. The caller decides how
 * the bytes reach the device (Zebra Browser Print on the workstation, a PDF
 * fallback, or a future local agent), which keeps this module testable against
 * golden strings.
 *
 * One ^XA…^XZ format describes one ROW of media. On 2-up / 3-up rolls the gap
 * sensor advances a row at a time, so the stickers within a row are placed by
 * x-offset rather than fed individually.
 */

export interface LabelItem {
  name: string;
  sku: string | null;
  price?: number | null;
  /** Code to encode. Defaults to the SKU. */
  code?: string | null;
  /** How many stickers of this product to print. */
  copies: number;
}

export interface BuildZplOptions {
  profile: RollProfile;
  dpi: number;
  /** ^MD burn temperature (-30…30). Thermal media usually wants a small bump. */
  darkness?: number;
  /** Encode as QR instead of a 1D barcode. */
  qr?: boolean;
  /** Skip this many sticker slots — lets a part-used roll start where it left off. */
  startOffset?: number;
  currencySymbol?: string;
}

/** One sticker's worth of resolved data. */
interface Sticker {
  item: LabelItem;
  code: string;
}

/**
 * Escape ZPL's control characters. `^`, `~` and `\` would otherwise be read as
 * commands mid-field; ^FH lets us pass them as hex escapes instead.
 */
function zplEscape(value: string): string {
  return value
    .replace(/\\/g, '\\5C')
    .replace(/\^/g, '\\5E')
    .replace(/~/g, '\\7E');
}

/** Trim to a rough character budget so long names can't overrun the sticker. */
function clamp(value: string, maxChars: number): string {
  const text = value.trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function money(value: number, symbol: string): string {
  return `${symbol} ${value.toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Expand copies into individual stickers, honouring the start offset. */
function toStickers(items: LabelItem[], startOffset: number): Array<Sticker | null> {
  const stickers: Array<Sticker | null> = Array.from({ length: Math.max(0, startOffset) }, () => null);
  for (const item of items) {
    const code = (item.code ?? item.sku ?? '').trim();
    if (!code) continue; // nothing to encode — skipped, reported by the service
    for (let i = 0; i < item.copies; i++) stickers.push({ item, code });
  }
  return stickers;
}

function chunk<T>(values: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < values.length; i += size) rows.push(values.slice(i, i + size));
  return rows;
}

/** Fields for a single sticker positioned at (originX, originY) in dots. */
function stickerFields(
  sticker: Sticker,
  originXDots: number,
  originYDots: number,
  options: BuildZplOptions,
): string[] {
  const { profile, dpi } = options;
  const symbol = options.currencySymbol ?? CURRENCY_SYMBOL;
  const out: string[] = [];

  const padX = mmToDots(1.5, dpi);
  const innerWidth = mmToDots(profile.stickerWidthMm - 3, dpi);
  const x = originXDots + padX;
  let y = originYDots + mmToDots(1, dpi);

  // ── product name ──
  if (profile.content.productName) {
    const nameHeight = mmToDots(profile.stickerWidthMm >= 80 ? 4 : 2.6, dpi);
    const maxChars = Math.floor(profile.stickerWidthMm / (profile.stickerWidthMm >= 80 ? 2.2 : 1.9));
    out.push(
      `^FO${x},${y}^A0N,${nameHeight},${nameHeight}` +
        `^FB${innerWidth},1,0,L^FH\\^FD${zplEscape(clamp(sticker.item.name, maxChars))}^FS`,
    );
    y += nameHeight + mmToDots(1, dpi);
  }

  // ── barcode ──
  const { symbology, data } = chooseSymbology(sticker.code, options.qr);
  const barHeight = mmToDots(profile.barcodeHeightMm, dpi);
  const human = profile.content.humanReadable ? 'Y' : 'N';

  if (symbology === 'QR') {
    // Magnification chosen so the symbol fits the allotted height.
    const magnification = Math.max(2, Math.min(10, Math.floor(barHeight / 21)));
    out.push(`^FO${x},${y}^BQN,2,${magnification}^FH\\^FDQA,${zplEscape(data)}^FS`);
    y += barHeight;
  } else {
    // Module width: the narrowest bar. 2 dots keeps 1D codes scannable at
    // 203 dpi; the smallest roll drops to 1 to fit 30mm.
    const moduleWidth = profile.stickerWidthMm >= 45 ? 2 : 1;
    out.push(`^BY${moduleWidth},3,${barHeight}`);
    if (symbology === 'UPC_A') {
      out.push(`^FO${x},${y}^BUN,${barHeight},${human},N^FD${data}^FS`);
    } else if (symbology === 'EAN_13') {
      out.push(`^FO${x},${y}^BEN,${barHeight},${human},N^FD${data}^FS`);
    } else {
      out.push(`^FO${x},${y}^BCN,${barHeight},${human},N,N^FH\\^FD${zplEscape(data)}^FS`);
    }
    // Human-readable digits are drawn by the printer beneath the bars.
    y += barHeight + (profile.content.humanReadable ? mmToDots(3.5, dpi) : mmToDots(1, dpi));
  }

  // ── footer: SKU on the left, price on the right ──
  const footHeight = mmToDots(profile.stickerWidthMm >= 80 ? 3.5 : 2.4, dpi);
  if (profile.content.sku && sticker.item.sku) {
    out.push(
      `^FO${x},${y}^A0N,${footHeight},${footHeight}` +
        `^FH\\^FD${zplEscape(clamp(sticker.item.sku, 24))}^FS`,
    );
  }
  if (profile.content.price && sticker.item.price != null) {
    out.push(
      `^FO${x},${y}^A0N,${footHeight},${footHeight}` +
        `^FB${innerWidth},1,0,R^FH\\^FD${zplEscape(money(sticker.item.price, symbol))}^FS`,
    );
  }

  return out;
}

/** Serialise one row of stickers into a complete ^XA…^XZ format. */
function buildRow(row: Array<Sticker | null>, options: BuildZplOptions, copies: number): string {
  const { profile, dpi } = options;
  const rowHeightDots = mmToDots(profile.stickerHeightMm + profile.marginTopMm, dpi);
  const widthDots = mmToDots(webWidthMm(profile), dpi);

  const lines: string[] = ['^XA', '^CI28'];
  if (options.darkness != null) lines.push(`^MD${options.darkness}`);
  lines.push(`^PW${widthDots}`, `^LL${rowHeightDots}`, '^LH0,0');

  row.forEach((sticker, column) => {
    if (!sticker) return; // start-offset placeholder — leave the slot blank
    const originX = mmToDots(
      profile.marginLeftMm + column * (profile.stickerWidthMm + profile.gapXMm) + profile.offsetXMm,
      dpi,
    );
    const originY = mmToDots(profile.marginTopMm + profile.offsetYMm, dpi);
    lines.push(...stickerFields(sticker, originX, originY, options));
  });

  if (copies > 1) lines.push(`^PQ${copies},0,0,N`);
  lines.push('^XZ');
  return lines.join('\n');
}

export interface BuildZplResult {
  zpl: string;
  /** Stickers actually emitted (excludes skipped items and offset blanks). */
  stickerCount: number;
  /** Physical rows the printer will feed. */
  rowCount: number;
  /** Products dropped because they had no code to encode. */
  skipped: string[];
}

export function buildZpl(items: LabelItem[], options: BuildZplOptions): BuildZplResult {
  const skipped = items.filter((i) => !(i.code ?? i.sku ?? '').trim()).map((i) => i.name);
  const stickers = toStickers(items, options.startOffset ?? 0);
  const rows = chunk(stickers, options.profile.columns);

  // Identical consecutive rows collapse into one format with ^PQ, so "200 of
  // the same product" is a handful of commands instead of 200.
  const formats: string[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    const signature = JSON.stringify(row);
    let repeats = 1;
    while (index + repeats < rows.length && JSON.stringify(rows[index + repeats]) === signature) {
      repeats++;
    }
    formats.push(buildRow(row, options, repeats));
    index += repeats;
  }

  return {
    zpl: formats.join('\n'),
    stickerCount: stickers.filter(Boolean).length,
    rowCount: rows.length,
    skipped,
  };
}
