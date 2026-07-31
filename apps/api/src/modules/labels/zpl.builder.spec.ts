import { getRollProfile, mmToDots, webWidthMm, DEFAULT_DPI } from './roll-profiles';
import { chooseSymbology, gtinCheckDigit } from './symbology';
import { buildZpl, type LabelItem } from './zpl.builder';

const item = (over: Partial<LabelItem> = {}): LabelItem => ({
  name: 'Cordless Drill 18V',
  sku: 'DRL-18V',
  price: 14500,
  copies: 1,
  ...over,
});

const build = (items: LabelItem[], roll: 'plain' | 'double' | 'triple', extra = {}) =>
  buildZpl(items, { profile: getRollProfile(roll), dpi: DEFAULT_DPI, ...extra });

describe('roll geometry', () => {
  it('converts millimetres to dots at 203 dpi', () => {
    expect(mmToDots(25.4)).toBe(203);
    expect(mmToDots(50)).toBe(400); // 50mm sticker on the double roll
  });

  it('reports the media width each roll needs', () => {
    // 2 × 50mm + one 2mm gap + 2 × 1mm margin
    expect(webWidthMm(getRollProfile('double'))).toBe(104);
    // 3 × 30mm + two 2mm gaps + 2 × 1mm margin
    expect(webWidthMm(getRollProfile('triple'))).toBe(96);
    expect(webWidthMm(getRollProfile('plain'))).toBe(94);
  });
});

describe('symbology selection', () => {
  it('computes GTIN check digits', () => {
    // 03600029145 + check 2 → the canonical UPC-A example
    expect(gtinCheckDigit('03600029145')).toBe(2);
  });

  it('uses UPC-A for a valid 12-digit code and strips the check digit', () => {
    expect(chooseSymbology('036000291452')).toEqual({ symbology: 'UPC_A', data: '03600029145' });
  });

  it('uses EAN-13 for a valid 13-digit code', () => {
    expect(chooseSymbology('4006381333931')).toEqual({ symbology: 'EAN_13', data: '400638133393' });
  });

  it('falls back to Code 128 for alphanumeric SKUs', () => {
    expect(chooseSymbology('DRL-18V')).toEqual({ symbology: 'CODE_128', data: 'DRL-18V' });
  });

  it('falls back to Code 128 when a numeric code has a bad check digit', () => {
    expect(chooseSymbology('036000291459').symbology).toBe('CODE_128');
  });

  it('honours an explicit QR request', () => {
    expect(chooseSymbology('DRL-18V', true).symbology).toBe('QR');
  });
});

describe('buildZpl', () => {
  it('emits one format per row and sets width/length from the profile', () => {
    const { zpl, rowCount, stickerCount } = build([item()], 'plain');
    expect(stickerCount).toBe(1);
    expect(rowCount).toBe(1);
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.trim().endsWith('^XZ')).toBe(true);
    expect(zpl).toContain('^CI28'); // UTF-8, so product names survive
    expect(zpl).toContain(`^PW${mmToDots(94)}`);
    expect(zpl).toContain(`^LL${mmToDots(45 + 2)}`);
  });

  it('packs three stickers into one row on the triple roll', () => {
    const { zpl, rowCount, stickerCount } = build([item({ copies: 3 })], 'triple');
    expect(stickerCount).toBe(3);
    expect(rowCount).toBe(1);
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    // Columns sit at margin, margin+30+2, margin+2*(30+2)
    expect(zpl).toContain(`^FO${mmToDots(1) + mmToDots(1.5)},`);
    expect(zpl).toContain(`^FO${mmToDots(33) + mmToDots(1.5)},`);
    expect(zpl).toContain(`^FO${mmToDots(65) + mmToDots(1.5)},`);
  });

  it('spills onto a second row when a row is full', () => {
    const { rowCount, stickerCount } = build([item({ copies: 5 })], 'double');
    expect(stickerCount).toBe(5);
    expect(rowCount).toBe(3); // 2 + 2 + 1
  });

  it('collapses identical consecutive rows into one format with ^PQ', () => {
    const { zpl, stickerCount } = build([item({ copies: 200 })], 'double');
    expect(stickerCount).toBe(200);
    expect(zpl).toContain('^PQ100,0,0,N'); // 200 stickers / 2 across
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
  });

  it('leaves the offset slots blank so a part-used roll resumes correctly', () => {
    const { zpl, rowCount, stickerCount } = build([item()], 'triple', { startOffset: 2 });
    expect(stickerCount).toBe(1);
    expect(rowCount).toBe(1);
    // Only the third column carries fields.
    expect(zpl).toContain(`^FO${mmToDots(65) + mmToDots(1.5)},`);
    expect(zpl).not.toContain(`^FO${mmToDots(1) + mmToDots(1.5)},${mmToDots(2.5)}^A0N`);
  });

  it('prints name and price on the plain roll but not on the triple', () => {
    expect(build([item()], 'plain').zpl).toContain('Cordless Drill 18V');
    expect(build([item()], 'plain').zpl).toContain('14,500.00');

    const triple = build([item()], 'triple').zpl;
    expect(triple).not.toContain('Cordless Drill 18V');
    expect(triple).not.toContain('14,500.00');
    expect(triple).toContain('DRL-18V'); // the code itself still prints
  });

  it('escapes ZPL control characters in product data', () => {
    const { zpl } = build([item({ name: 'Bolt ^ Nut ~ Set' })], 'plain');
    expect(zpl).toContain('Bolt \\5E Nut \\7E Set');
    expect(zpl).toContain('^FH\\');
  });

  it('reports products with no code instead of printing a blank sticker', () => {
    const { skipped, stickerCount } = build([item({ sku: null, code: null })], 'plain');
    expect(skipped).toEqual(['Cordless Drill 18V']);
    expect(stickerCount).toBe(0);
  });

  it('encodes QR when requested', () => {
    const { zpl } = build([item()], 'plain', { qr: true });
    expect(zpl).toContain('^BQN,2,');
    expect(zpl).toContain('^FDQA,DRL-18V^FS');
  });

  it('applies darkness only when supplied', () => {
    expect(build([item()], 'plain', { darkness: 8 }).zpl).toContain('^MD8');
    expect(build([item()], 'plain').zpl).not.toContain('^MD');
  });
});
