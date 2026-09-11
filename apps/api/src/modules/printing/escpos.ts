/**
 * D67 — a minimal ESC/POS encoder.
 *
 * In-repo rather than an npm dependency, deliberately: the subset a receipt
 * printer needs is a dozen commands, owning it keeps the byte stream
 * inspectable in tests (every template spec asserts real bytes), and it
 * avoids a supply-chain dependency in the one code path that talks to
 * hardware on a customer's LAN.
 *
 * Everything here is pure: a builder over a byte buffer with no I/O, so a
 * template can be rendered and asserted without a printer, and the same
 * bytes can be replayed byte-for-byte on a reprint.
 */

/** ESC/POS control sequences, named so call sites read as intent. */
const ESC = 0x1b;
const GS = 0x1d;

export type Align = 'left' | 'center' | 'right';

export interface BuilderOptions {
  /**
   * D174 — emit plain text instead of ESC/POS: no control sequences at all,
   * centring done with spaces, a cut becomes a form feed. For an OFFICE
   * printer driven through the Windows spooler as a text document (kind
   * A4_NETWORK) — a device that would print an ESC/POS stream as nothing, or
   * as a page of punctuation. The templates do not know which mode they are
   * in; that is the point.
   */
  plainText?: boolean;
}

export class EscPosBuilder {
  private readonly chunks: number[] = [];
  private readonly plainText: boolean;
  private currentAlign: Align = 'left';

  /**
   * @param columns characters per line — 48 on 80 mm paper, 32 on 58 mm.
   *   Drives wrapping and the two-column `row()` layout.
   */
  constructor(
    readonly columns = 48,
    options: BuilderOptions = {},
  ) {
    this.plainText = options.plainText === true;
  }

  /** Reset the printer to a known state. Every document starts here. */
  init(): this {
    return this.control([ESC, 0x40]);
  }

  align(mode: Align): this {
    this.currentAlign = mode;
    const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2;
    return this.control([ESC, 0x61, n]);
  }

  bold(on: boolean): this {
    return this.control([ESC, 0x45, on ? 1 : 0]);
  }

  /** Double width AND height — the ticket's destination, the grand total. */
  doubleSize(on: boolean): this {
    return this.control([GS, 0x21, on ? 0x11 : 0x00]);
  }

  /**
   * Double HEIGHT only — the KOT item lines. Keeps the roll's full column
   * count, so our word-wrap and the printer's agree on where a line ends.
   */
  doubleHeight(on: boolean): this {
    return this.control([GS, 0x21, on ? 0x01 : 0x00]);
  }

  underline(on: boolean): this {
    return this.control([ESC, 0x2d, on ? 1 : 0]);
  }

  /**
   * A line of text, encoded and newline-terminated. Long text WRAPS at the
   * paper width rather than being truncated: a dropped modifier or a cut-off
   * dish name is a wrong ticket, and the kitchen cannot tell it happened.
   */
  line(text = ''): this {
    if (text.length === 0) return this.raw([0x0a]);
    for (const part of wrap(text, this.columns)) {
      this.raw(this.plainText ? encodePlain(this.justify(part)) : encode(part));
      this.raw([0x0a]);
    }
    return this;
  }

  /** Plain text has no alignment command, so centre/right are done with spaces. */
  private justify(part: string): string {
    if (this.currentAlign === 'left' || part.length >= this.columns) return part;
    const gap = this.columns - part.length;
    return ' '.repeat(this.currentAlign === 'center' ? Math.floor(gap / 2) : gap) + part;
  }

  /**
   * A label/value row: label left, value right-aligned to the paper width.
   * When the pair cannot fit, the value keeps the right edge and the label
   * is truncated — money must never be the thing that gets cut.
   */
  row(label: string, value: string): this {
    const room = Math.max(0, this.columns - value.length - 1);
    const left = label.length > room ? label.slice(0, room) : label;
    const pad = Math.max(1, this.columns - left.length - value.length);
    return this.line(`${left}${' '.repeat(pad)}${value}`);
  }

  /** A full-width separator. */
  hr(char = '-'): this {
    return this.line(char.repeat(this.columns));
  }

  feed(lines = 1): this {
    const n = Math.max(0, Math.min(255, lines));
    if (this.plainText) return this.raw(Array<number>(n).fill(0x0a));
    return this.raw([ESC, 0x64, n]);
  }

  /** Partial cut. Harmless on printers without a cutter. Plain text: eject the page. */
  cut(): this {
    if (this.plainText) return this.feed(3).raw([0x0c]);
    return this.feed(3).raw([GS, 0x56, 0x42, 0x00]);
  }

  /**
   * Cash-drawer kick (pin 2, 100 ms). Only emitted where a caller asks —
   * a drawer that pops on a kitchen ticket is a support call.
   */
  pulse(): this {
    return this.control([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  /** A control sequence: emitted for ESC/POS, dropped for plain text. */
  private control(bytes: number[]): this {
    return this.plainText ? this : this.raw(bytes);
  }

  raw(bytes: number[] | Uint8Array): this {
    for (const b of bytes) this.chunks.push(b & 0xff);
    return this;
  }

  build(): Buffer {
    return Buffer.from(this.chunks);
  }
}

/**
 * Encode text for a thermal printer's default code page (CP437).
 *
 * Latin letters, digits and punctuation map 1:1. Accented Latin is
 * transliterated (é → e) rather than dropped; anything still unmappable
 * becomes '?' — VISIBLY wrong on paper, which is the honest outcome: a
 * silently missing character on a kitchen ticket is a wrong order.
 * Non-Latin scripts (Sinhala, Tamil) need raster-mode rendering and are a
 * documented limitation, not a silent failure.
 */
export function encode(text: string): number[] {
  const flattened = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out: number[] = [];
  for (const ch of flattened) {
    const code = ch.codePointAt(0) ?? 0x3f;
    out.push(code >= 0x20 && code <= 0x7e ? code : CP437_EXTRA[ch] ?? 0x3f);
  }
  return out;
}

/**
 * D174 — the same transliteration for a plain-text document, but to ASCII
 * only: CP437's extra glyphs are different characters in every other code
 * page, and the Windows text print processor uses the machine's own.
 */
export function encodePlain(text: string): number[] {
  const flattened = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out: number[] = [];
  for (const ch of flattened) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
      continue;
    }
    const ascii = PLAIN_EXTRA[ch] ?? '?';
    for (const c of ascii) out.push(c.charCodeAt(0));
  }
  return out;
}

const PLAIN_EXTRA: Record<string, string> = {
  '·': '-',
  '—': '-',
  '–': '-',
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '°': ' deg',
  '½': '1/2',
  '¼': '1/4',
};

/** The handful of non-ASCII glyphs worth mapping for the pilot market. */
const CP437_EXTRA: Record<string, number> = {
  '£': 0x9c,
  '¥': 0x9d,
  '·': 0xfa,
  '±': 0xf1,
  '°': 0xf8,
  '½': 0xab,
  '¼': 0xac,
  '—': 0x2d,
  '–': 0x2d,
  '’': 0x27,
  '‘': 0x27,
  '“': 0x22,
  '”': 0x22,
  '…': 0x2e,
};

/**
 * Greedy word wrap; a word longer than the width is hard-split.
 *
 * Leading spaces are LAYOUT — a modifier indented under its dish — and are
 * kept on every wrapped line, so a long note stays under the item it belongs
 * to. (D67's wrap split on spaces and rebuilt, which silently ate the indent;
 * its tests asserted the words and never the position, so the KOT's notes
 * printed flush left without anyone noticing.)
 */
export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const indent = /^ */.exec(paragraph)?.[0] ?? '';
    const width = Math.max(1, columns - indent.length);
    for (const line of wrapWords(paragraph.slice(indent.length), width)) {
      lines.push(indent + line);
    }
  }
  return lines;
}

function wrapWords(paragraph: string, columns: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of paragraph.split(' ')) {
    let w = word;
    while (w.length > columns) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(w.slice(0, columns));
      w = w.slice(columns);
    }
    if (current.length === 0) current = w;
    else if (current.length + 1 + w.length <= columns) current += ` ${w}`;
    else {
      lines.push(current);
      current = w;
    }
  }
  lines.push(current);
  return lines;
}
