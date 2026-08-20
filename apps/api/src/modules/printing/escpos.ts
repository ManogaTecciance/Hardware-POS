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

export class EscPosBuilder {
  private readonly chunks: number[] = [];

  /**
   * @param columns characters per line — 48 on 80 mm paper, 32 on 58 mm.
   *   Drives wrapping and the two-column `row()` layout.
   */
  constructor(readonly columns = 48) {}

  /** Reset the printer to a known state. Every document starts here. */
  init(): this {
    return this.raw([ESC, 0x40]);
  }

  align(mode: Align): this {
    const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2;
    return this.raw([ESC, 0x61, n]);
  }

  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** Double width AND height — the KOT item lines and the grand total. */
  doubleSize(on: boolean): this {
    return this.raw([GS, 0x21, on ? 0x11 : 0x00]);
  }

  underline(on: boolean): this {
    return this.raw([ESC, 0x2d, on ? 1 : 0]);
  }

  /**
   * A line of text, encoded and newline-terminated. Long text WRAPS at the
   * paper width rather than being truncated: a dropped modifier or a cut-off
   * dish name is a wrong ticket, and the kitchen cannot tell it happened.
   */
  line(text = ''): this {
    if (text.length === 0) return this.raw([0x0a]);
    for (const part of wrap(text, this.columns)) {
      this.raw(encode(part));
      this.raw([0x0a]);
    }
    return this;
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
    return this.raw([ESC, 0x64, Math.max(0, Math.min(255, lines))]);
  }

  /** Partial cut. Harmless on printers without a cutter. */
  cut(): this {
    return this.feed(3).raw([GS, 0x56, 0x42, 0x00]);
  }

  /**
   * Cash-drawer kick (pin 2, 100 ms). Only emitted where a caller asks —
   * a drawer that pops on a kitchen ticket is a support call.
   */
  pulse(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
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

/** Greedy word wrap; a word longer than the width is hard-split. */
export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
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
  }
  return lines;
}
