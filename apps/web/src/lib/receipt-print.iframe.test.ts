/**
 * D79 — receipts print from a hidden iframe, and no window is ever opened.
 *
 * ## Why this is the assertion that matters
 *
 * "The print window does not close" was reported four times. It was chased
 * from the opener (Chrome ignores `close()` while the preview is up, and does
 * not deliver `afterprint` to a listener the opener registered), then from a
 * script inside the popup, and each fix looked right and changed nothing.
 *
 * The window is now gone entirely, so the regression to guard is not "does it
 * close" but "was one opened at all" — a single `window.open` anywhere in
 * this module brings the whole class of defect back. That is asserted
 * directly: `window.open` is stubbed to fail the test if it is ever called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', () => ({
  getCachedDocumentProfile: () => ({ companyName: 'X' }),
}));
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => String(v) }));
vi.mock('./restaurant/labels', () => ({ formatMoney: (v: number | string) => String(v) }));

let opened = 0;
let written = '';
let injected: string[] = [];
let printed = 0;
let removed = 0;
let frameStyle = '';
let bodyHeight = 1000;

function fakeFrame() {
  const win = {
    focus: () => {},
    print: () => {
      printed += 1;
    },
    addEventListener: () => {},
    document: {
      open: () => {},
      write: (h: string) => {
        written = h;
      },
      close: () => {},
      images: [] as unknown[],
      body: {
        get scrollHeight() {
          return bodyHeight;
        },
      },
      documentElement: { scrollHeight: 0 },
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
      head: {
        appendChild: (el: unknown) => injected.push((el as { textContent: string }).textContent),
      },
    },
  };
  return {
    style: {
      set cssText(v: string) {
        frameStyle = v;
      },
      get cssText() {
        return frameStyle;
      },
    },
    setAttribute: () => {},
    title: '',
    contentWindow: win,
    contentDocument: win.document,
    remove: () => {
      removed += 1;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  opened = 0;
  written = '';
  injected = [];
  printed = 0;
  removed = 0;
  frameStyle = '';
  bodyHeight = 1000;

  const frame = fakeFrame();
  vi.stubGlobal('document', {
    createElement: () => frame,
    body: { appendChild: () => {} },
  });
  vi.stubGlobal('window', {
    open: () => {
      opened += 1;
      return null;
    },
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { printReceipt, openPrintWindow } = await import('./receipt-print');

describe('printReceipt', () => {
  it('opens NO window, and prints from a frame instead', async () => {
    printReceipt('<p>bill</p>');
    await vi.runAllTimersAsync();

    // The claim the four rounds were about.
    expect(opened).toBe(0);
    // …paired with the positive: it really did print.
    expect(printed).toBe(1);
    expect(written).toBe('<p>bill</p>');
  });

  it('lays the frame out at the receipt width, off-screen', async () => {
    printReceipt('<p>bill</p>');
    await vi.runAllTimersAsync();
    /*
     * Off-screen, not 0×0. A zero-width frame lays out at zero width, wraps
     * every line, and reports a height with no relation to the printed bill —
     * which is then written into `@page` and cuts the receipt short.
     */
    expect(frameStyle).toContain('width:295px'); // 78mm at 96dpi
    expect(frameStyle).toContain('left:-10000px');
    expect(frameStyle).not.toContain('width:0');
  });

  it('removes the frame once the browser is finished', async () => {
    printReceipt('<p>bill</p>');
    await vi.runAllTimersAsync();
    // Invisible either way, so a late removal costs nothing — but it must
    // happen, or every print leaves a detached document behind.
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('sizes the page to the content for a receipt', async () => {
    printReceipt('<p>bill</p>');
    await vi.runAllTimersAsync();
    // 1000px ÷ 96dpi × 25.4 = 264.58 → 265mm, +2mm of cutter margin.
    expect(injected).toEqual(['@page{size:78mm 267mm;margin:0}']);
    // `size: 78mm auto` is invalid CSS; browsers drop the declaration.
    expect(injected[0]).not.toContain('auto');
  });
});

describe('openPrintWindow — the legacy name', () => {
  it('opens no window either, and leaves the page size to the printer', async () => {
    openPrintWindow('<p>retail receipt</p>');
    await vi.runAllTimersAsync();

    expect(opened).toBe(0);
    expect(printed).toBe(1);
    /*
     * A retail receipt prints to whatever sheet the till is set up with
     * (D16). Only the thermal bill asks to be sized to its content, so this
     * path must NOT declare a page.
     */
    expect(injected).toHaveLength(0);
  });
});
