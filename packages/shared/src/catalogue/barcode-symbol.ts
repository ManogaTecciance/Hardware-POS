/**
 * Barcode symbol encoding (Phase 5, step `5.7`).
 *
 * Pure module-pattern generators plus an SVG builder, in `shared` because the
 * API renders the print job and the web preview renders the same label. Two
 * copies of an encoder would be two barcodes, and the second one would be
 * discovered by a scanner rather than by a test.
 *
 * No library: the two symbologies a shop needs are a table lookup and a
 * checksum, the CDN allowlist does not matter here, and a dependency that
 * renders to canvas cannot be used inside a print-job HTML string.
 */

import { isValidEan13, looksLikeEan13 } from './ean13.js';

/** Left-hand odd parity ("L"). Index is the digit. */
const EAN13_L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

/** Left-hand even parity ("G"). */
const EAN13_G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
];

/** Right-hand ("R") — the bitwise complement of L. */
const EAN13_R = EAN13_L.map((p) => p.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));

/**
 * Which of the first six digits use G rather than L.
 *
 * This is where the 13th digit of information lives: an EAN-13 symbol encodes
 * only 12 digits directly, and the FIRST digit is carried by the parity pattern
 * of the left half. That is why a "12-digit" reading of the standard produces a
 * scanner-rejected symbol.
 */
const EAN13_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

/**
 * Encode an EAN-13 into its 95 modules, `1` = bar.
 *
 * Returns `null` for anything that is not a valid EAN-13 — including a
 * 13-digit code with a wrong check digit. That refusal IS the `5.9` finding:
 * 18 of the pilot's 20 codes land here, and a renderer that drew them anyway
 * would produce a symbol no scanner accepts.
 */
export function encodeEan13(code: string): string | null {
  if (!looksLikeEan13(code) || !isValidEan13(code)) return null;

  const digits = [...code].map((c) => c.charCodeAt(0) - 48);
  const at = (table: readonly string[], index: number | undefined): string => {
    const entry = index === undefined ? undefined : table[index];
    // Unreachable for a validated EAN-13. Throwing rather than substituting a
    // pattern keeps a future change from silently drawing the wrong bars.
    if (entry === undefined) throw new Error('EAN-13 encoding table index out of range');
    return entry;
  };

  const parity = at(EAN13_PARITY, digits[0]);

  let modules = '101'; // start guard
  for (let i = 0; i < 6; i += 1) {
    modules += at(parity[i] === 'L' ? EAN13_L : EAN13_G, digits[i + 1]);
  }
  modules += '01010'; // centre guard
  for (let i = 7; i < 13; i += 1) {
    modules += at(EAN13_R, digits[i]);
  }
  modules += '101'; // end guard
  return modules;
}

/**
 * Code 128 bar/space widths, indexed by symbol value 0-106.
 *
 * Each entry is six digits: bar, space, bar, space, bar, space, in modules.
 * Kept as a table because it is one — deriving it would be longer and wrong.
 */
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

/**
 * Encode ASCII 32-126 as Code 128 subset B.
 *
 * Subset B only, deliberately: it covers every printable character a SKU can
 * contain, and switching subsets to compress digits would add a code path whose
 * only benefit is a slightly narrower symbol.
 */
export function encodeCode128(value: string): string | null {
  if (value.length === 0) return null;

  const values: number[] = [CODE128_START_B];
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) return null; // outside subset B
    values.push(code - 32);
  }

  // Checksum: start value plus each symbol weighted by its position, mod 103.
  let checksum = CODE128_START_B;
  for (let i = 1; i < values.length; i += 1) checksum += (values[i] ?? 0) * i;
  values.push(checksum % 103);
  values.push(CODE128_STOP);

  let modules = '';
  for (const value of values) {
    const pattern = CODE128_PATTERNS[value];
    if (pattern === undefined) return null; // outside the 0-106 table
    let bar = true;
    for (const width of pattern) {
      modules += (bar ? '1' : '0').repeat(width.charCodeAt(0) - 48);
      bar = !bar;
    }
  }
  return modules;
}

export type Symbology = 'EAN13' | 'CODE128';

/**
 * Render a module string as an SVG, sized in millimetres.
 *
 * Returns `null` when the value cannot be encoded, so a caller must decide what
 * to do about it. Drawing a placeholder or an empty box would put a label on a
 * shelf that scans as nothing.
 */
export function barcodeSvg(
  value: string,
  symbology: Symbology,
  size: { widthMm: number; heightMm: number },
): string | null {
  const modules = symbology === 'EAN13' ? encodeEan13(value) : encodeCode128(value);
  if (modules === null) return null;

  const moduleWidth = size.widthMm / modules.length;
  const bars: string[] = [];
  let run = 0;
  for (let i = 0; i <= modules.length; i += 1) {
    if (modules[i] === '1') {
      run += 1;
      continue;
    }
    if (run > 0) {
      const x = (i - run) * moduleWidth;
      bars.push(
        `<rect x="${x.toFixed(4)}" y="0" width="${(run * moduleWidth).toFixed(4)}" height="${size.heightMm}" />`,
      );
      run = 0;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.widthMm}mm" height="${size.heightMm}mm"`,
    ` viewBox="0 0 ${size.widthMm} ${size.heightMm}" shape-rendering="crispEdges" fill="#000">`,
    bars.join(''),
    '</svg>',
  ].join('');
}
