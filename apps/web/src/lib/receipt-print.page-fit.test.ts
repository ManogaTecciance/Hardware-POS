/**
 * D73 — the printed page is sized to the receipt, not to a sheet.
 *
 * ## What is actually at risk
 *
 * A receipt roll is continuous. If the page keeps a sheet's height, a long
 * order breaks across two "pages" — and on a roll printer that means the
 * cutter fires mid-bill and the totals come out on a separate strip. So the
 * height is measured after layout and written into `@page`.
 *
 * Every assertion here is about the ORDER and the ARITHMETIC of that, because
 * both have silent failure modes: measuring before images decode truncates
 * the receipt to the height of the text alone, and `size: 80mm auto` is
 * invalid CSS that browsers drop on the floor without complaint — leaving a
 * bill that looks fine in review and prints on two sheets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', () => ({
  getCachedDocumentProfile: () => ({ companyName: 'X' }),
}));
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => String(v) }));
vi.mock('./restaurant/labels', () => ({ formatMoney: (v: number | string) => String(v) }));

interface FakeImage {
  complete: boolean;
  addEventListener: (type: string, fn: () => void, opts?: unknown) => void;
}

let win: {
  document: {
    open: () => void;
    write: (h: string) => void;
    close: () => void;
    images: FakeImage[];
    head: { appendChild: (el: unknown) => void };
    body: { scrollHeight: number };
    documentElement: { scrollHeight: number };
    createElement: () => { dataset: Record<string, string>; textContent: string };
  };
  focus: () => void;
  print: () => void;
};
let appended: { textContent: string }[] = [];
let printedAt = -1;
let sequence = 0;

function makeWindow(bodyHeight: number, images: FakeImage[] = []) {
  appended = [];
  printedAt = -1;
  sequence = 0;
  return {
    document: {
      open: () => {},
      write: () => {},
      close: () => {},
      images,
      head: {
        appendChild: (el: unknown) => {
          appended.push(el as { textContent: string });
        },
      },
      body: { scrollHeight: bodyHeight },
      documentElement: { scrollHeight: 0 },
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
    },
    focus: () => {},
    print: () => {
      printedAt = sequence++;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  win = makeWindow(1000);
  vi.stubGlobal('window', {
    open: () => win,
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { openPrintWindow } = await import('./receipt-print');

describe('fitToContent', () => {
  it('writes a page exactly as tall as the document, in millimetres', async () => {
    openPrintWindow('<p>x</p>', { fitToContent: true, paperWidthMm: 80 });
    await vi.runAllTimersAsync();

    const rule = appended.map((el) => el.textContent).join('');
    // 1000px ÷ 96dpi × 25.4 = 264.58mm → 265, plus 4mm of cutter margin.
    expect(rule).toBe('@page{size:80mm 269mm;margin:0}');
    // `size: <width> auto` is invalid CSS and silently ignored — a bill that
    // relied on it would print on sheets. Both values must be lengths.
    expect(rule).not.toContain('auto');
  });

  it('honours a narrower roll', async () => {
    openPrintWindow('<p>x</p>', { fitToContent: true, paperWidthMm: 58 });
    await vi.runAllTimersAsync();
    expect(appended[0]!.textContent).toContain('58mm');
  });

  it('leaves the page alone for every other caller', async () => {
    // The retail receipt prints to whatever sheet the operator chose (D16).
    openPrintWindow('<p>x</p>');
    await vi.runAllTimersAsync();
    expect(appended).toHaveLength(0);
    // POSITIVE CONTROL — it still printed, so the absence above is about the
    // option and not about the whole function having bailed out.
    expect(printedAt).toBeGreaterThanOrEqual(0);
  });

  it('measures AFTER images settle, never before', async () => {
    /*
     * The logo is the tallest thing on the bill. Measuring while it is still
     * decoding reports the height of the text alone and cuts the receipt
     * short — so the style must be appended only once the image resolves.
     */
    let resolveImage = () => {};
    const image: FakeImage = {
      complete: false,
      addEventListener: (type, fn) => {
        if (type === 'load') resolveImage = fn;
      },
    };
    win = makeWindow(200, [image]);

    openPrintWindow('<img>', { fitToContent: true });
    await vi.advanceTimersByTimeAsync(50);
    // Still decoding: nothing measured, nothing printed.
    expect(appended).toHaveLength(0);
    expect(printedAt).toBe(-1);

    // The image lands and the document grows to its real height.
    win.document.body.scrollHeight = 800;
    resolveImage();
    await vi.runAllTimersAsync();

    expect(appended).toHaveLength(1);
    // 800px ÷ 96 × 25.4 = 211.67 → 212, +4mm cutter margin = 216mm.
    expect(appended[0]!.textContent).toContain('216mm');
    // NEGATIVE — and NOT the 57mm the pre-image document would have given
    // (200px → 53mm + 4). That is the truncated receipt this ordering exists
    // to prevent, so it is named rather than merely implied.
    expect(appended[0]!.textContent).not.toContain('57mm');
    expect(printedAt).toBeGreaterThanOrEqual(0);
  });

  it('leaves the default sheet alone rather than emitting a zero-height page', async () => {
    win = makeWindow(0);
    openPrintWindow('<p>x</p>', { fitToContent: true });
    await vi.runAllTimersAsync();
    // A 0mm page would print nothing at all; a sheet at least prints.
    expect(appended).toHaveLength(0);
    expect(printedAt).toBeGreaterThanOrEqual(0);
  });
});
