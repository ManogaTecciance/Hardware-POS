/**
 * D77 — what the OPENER still owns.
 *
 * Printing and closing moved into a script inside the receipt itself, because
 * neither worked from out here: `otherWindow.print()` does not block the
 * caller, and Chrome ignores a `close()` issued by the opener while the
 * popup's print preview is up. The receipt window stayed open for the PO
 * twice on the strength of those two assumptions.
 *
 * What is left on this side is the window's LIFECYCLE, and it is worth
 * guarding: opening it in the click's own turn, and not leaving a blank
 * popup behind when the data it was opened for never arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', () => ({
  getCachedDocumentProfile: () => ({ companyName: 'X' }),
}));
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => String(v) }));
vi.mock('./restaurant/labels', () => ({ formatMoney: (v: number | string) => String(v) }));

let log: string[] = [];
let written = '';
let injected: string[] = [];
let bodyHeight = 1000;
let win: Record<string, unknown>;

function makeWindow() {
  log = [];
  written = '';
  injected = [];
  return {
    document: {
      open: () => log.push('open'),
      write: (h: string) => {
        written = h;
        log.push('write');
      },
      close: () => log.push('doc-close'),
      images: [] as unknown[],
      body: {
        get scrollHeight() {
          return bodyHeight;
        },
      },
      documentElement: { scrollHeight: 0 },
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
      head: {
        appendChild: (el: unknown) => {
          injected.push((el as { textContent: string }).textContent);
          log.push('page-size');
        },
      },
    },
    closed: false,
    focus: () => log.push('focus'),
    addEventListener: () => {},
    print: () => log.push('print'),
    close: () => {
      log.push('close');
      (win as { closed: boolean }).closed = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  bodyHeight = 1000;
  win = makeWindow();
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

const { openPrintWindow, beginPrintWindow } = await import('./receipt-print');

describe('beginPrintWindow — opened in the click, filled in later', () => {
  it('opens the popup before any data has been fetched', () => {
    beginPrintWindow();
    /*
     * The whole point: `window.open` has already happened by the time this
     * returns. Opened after an `await`, it gambles on the browser's transient
     * user activation not having lapsed — and when it has, the popup is
     * blocked and nothing appears to happen at all.
     */
    expect(log).toContain('write'); // the placeholder is already on screen
    expect(written).toContain('Preparing');
  });

  it('writes the receipt when it arrives', () => {
    beginPrintWindow().render('<p>the bill</p>');
    expect(written).toBe('<p>the bill</p>');
  });

  it('closes the placeholder when the data never arrives', () => {
    beginPrintWindow().abort();
    // A window opened up front must not be left blank and orphaned.
    expect(log).toContain('close');
  });
});

describe('page sizing is opt-in', () => {
  it('declares no page size by default', () => {
    beginPrintWindow().render('<p>bill</p>');
    /*
     * D77 — correct size beats one page. `@page { size }` is a request, and
     * where the height exceeds the paper the driver reports, Chrome scales
     * the page down: the bill printed small on the PO's printer at 432mm and
     * again at 223mm. The size is the printer's to choose.
     */
    expect(injected).toHaveLength(0);
  });

  it('declares one when a caller asks for it, in lengths not `auto`', () => {
    beginPrintWindow({ fitToContent: true }).render('<p>bill</p>');
    // 1000px ÷ 96dpi × 25.4 = 264.58 → 265mm, +2mm of cutter margin.
    expect(injected).toEqual(['@page{size:72mm 267mm;margin:0}']);
    // `size: 80mm auto` is invalid CSS — the property takes one or two
    // lengths — and browsers drop the whole declaration.
    expect(injected[0]).not.toContain('auto');
  });

  it('honours a narrower roll', () => {
    beginPrintWindow({ fitToContent: true, paperWidthMm: 58 }).render('<p>bill</p>');
    expect(injected[0]).toContain('58mm');
  });

  it('leaves the sheet alone when nothing laid out', () => {
    bodyHeight = 0;
    win = makeWindow();
    beginPrintWindow({ fitToContent: true }).render('<p>bill</p>');
    // A 0mm page would print nothing at all.
    expect(injected).toHaveLength(0);
  });

  it('one-shot printing takes the same default', () => {
    openPrintWindow('<p>bill</p>');
    expect(injected).toHaveLength(0);
    expect(written).toBe('<p>bill</p>');
  });
});
