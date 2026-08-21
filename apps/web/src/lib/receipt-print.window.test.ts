/**
 * D74 — what the print popup does on its own.
 *
 * Two claims, both with silent failure modes:
 *
 *   • The dialog opens WITHOUT anyone clicking the page. If `print()` were
 *     only wired to the in-page button, the operator would face a receipt
 *     window that just sits there — which looks like the Print bill button
 *     did nothing.
 *   • The popup closes once the browser is done with it. `afterprint` has
 *     to be subscribed BEFORE `print()`, because `print()` is synchronous in
 *     some browsers and the event has already fired by the time it returns.
 *     Subscribing after would leave a dead receipt window open behind the
 *     POS on exactly those browsers — and pass any test that only checked
 *     the listener exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', () => ({
  getCachedDocumentProfile: () => ({ companyName: 'X' }),
}));
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => String(v) }));
vi.mock('./restaurant/labels', () => ({ formatMoney: (v: number | string) => String(v) }));

/** Everything the fake window did, in order. */
let log: string[] = [];
let handlers: Record<string, () => void> = {};
let win: Record<string, unknown>;

let injected: string[] = [];
let bodyHeight = 1000;

function makeWindow(images: unknown[] = []) {
  log = [];
  handlers = {};
  injected = [];
  return {
    document: {
      open: () => {},
      write: () => {},
      close: () => {},
      images,
      body: { get scrollHeight() { return bodyHeight; } },
      documentElement: { scrollHeight: 0 },
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
      head: {
        appendChild: (el: unknown) => {
          const style = el as { textContent: string };
          injected.push(style.textContent);
          log.push('page-size');
        },
      },
    },
    focus: () => {},
    addEventListener: (type: string, fn: () => void) => {
      log.push(`on:${type}`);
      handlers[type] = fn;
    },
    print: () => log.push('print'),
    close: () => log.push('close'),
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

describe('the print popup', () => {
  it('opens the dialog by itself, with no click on the page', async () => {
    openPrintWindow('<p>bill</p>');
    // Nothing yet — layout and images get a beat first.
    expect(log).not.toContain('print');

    await vi.runAllTimersAsync();
    expect(log).toContain('print');
  });

  it('subscribes to afterprint BEFORE printing', async () => {
    openPrintWindow('<p>bill</p>');
    await vi.runAllTimersAsync();

    // Order, not mere presence: a synchronous `print()` fires afterprint
    // before it returns, so a listener attached afterwards never runs.
    expect(log.indexOf('on:afterprint')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('on:afterprint')).toBeLessThan(log.indexOf('print'));
  });

  it('closes the popup when the browser is finished with it', async () => {
    openPrintWindow('<p>bill</p>');
    await vi.runAllTimersAsync();
    expect(log).not.toContain('close');

    // The browser reports it is done — printed or dismissed, the web has no
    // way to tell the two apart and the operator wants out of it either way.
    handlers.afterprint!();
    expect(log).toContain('close');
  });

  it('does not close before the print has been dispatched', async () => {
    openPrintWindow('<p>bill</p>');
    // Nothing has printed yet, so nothing may have closed either — a popup
    // that closed early would take the dialog down with it.
    expect(log).not.toContain('close');
    expect(log).not.toContain('print');
  });
});

describe('beginPrintWindow — opened in the click, filled in later', () => {
  it('opens the popup immediately, before any data has been fetched', () => {
    const pending = beginPrintWindow();
    /*
     * The whole point: `window.open` has already happened by the time this
     * returns. A popup opened after an await gambles on the browser's
     * transient user activation not having lapsed, and when it has, nothing
     * appears to happen at all.
     */
    expect(win).toBeTruthy();
    // Nothing printed yet — there is no bill to print.
    expect(log).not.toContain('print');
    expect(pending).toHaveProperty('render');
  });

  it('prints once the document arrives', async () => {
    const pending = beginPrintWindow();
    pending.render('<p>bill</p>');
    await vi.runAllTimersAsync();
    expect(log).toContain('print');
    expect(log.indexOf('on:afterprint')).toBeLessThan(log.indexOf('print'));
  });

  it('closes the placeholder when the data never arrives', () => {
    const pending = beginPrintWindow();
    pending.abort();
    // A window opened up front must not be left blank and orphaned when the
    // fetch it was opened for fails.
    expect(log).toContain('close');
  });
});

describe('D75 — one page, as tall as the receipt', () => {
  it('sizes the page to the content and prints it as a single page', async () => {
    beginPrintWindow().render('<p>bill</p>');
    await vi.runAllTimersAsync();

    // 1000px ÷ 96dpi × 25.4 = 264.58 → 265mm, +2mm so the cutter does not
    // shave the footer.
    expect(injected).toEqual(['@page{size:80mm 267mm;margin:0}']);
    /*
     * `size: 80mm auto` would be the obvious thing to write and is invalid
     * CSS — the property takes one or two lengths — so browsers drop the
     * whole declaration and the receipt goes back to paging.
     */
    expect(injected[0]).not.toContain('auto');
  });

  it('measures AFTER images settle, never before', async () => {
    /*
     * The logo is the tallest thing on the bill. Measured while it is still
     * decoding, the document reports the height of its text alone and the
     * receipt is cut short.
     */
    let landed = () => {};
    const image = {
      complete: false,
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'load') landed = fn;
      },
    };
    bodyHeight = 200;
    win = makeWindow([image]);

    beginPrintWindow().render('<img>');
    await vi.advanceTimersByTimeAsync(50);
    expect(injected).toHaveLength(0);
    expect(log).not.toContain('print');

    bodyHeight = 800; // the logo lands and the document grows
    landed();
    await vi.runAllTimersAsync();

    // 800px → 212mm (+2). NOT the 55mm the pre-image document would give.
    expect(injected[0]).toContain('214mm');
    expect(injected[0]).not.toContain('55mm');
  });

  it('sizes the page BEFORE printing, not after', async () => {
    beginPrintWindow().render('<p>bill</p>');
    await vi.runAllTimersAsync();
    // A size applied after `print()` has already captured the document
    // changes nothing at all.
    expect(log.indexOf('page-size')).toBeLessThan(log.indexOf('print'));
  });

  it('honours a narrower roll, and can be switched off entirely', async () => {
    beginPrintWindow({ paperWidthMm: 58 }).render('<p>bill</p>');
    await vi.runAllTimersAsync();
    expect(injected[0]).toContain('58mm');

    // A printer whose driver has a FIXED page length cannot honour a custom
    // size — Chrome scales the page to fit and the bill prints tiny. That
    // workspace turns the fitting off and pages normally instead.
    win = makeWindow();
    beginPrintWindow({ fitToContent: false }).render('<p>bill</p>');
    await vi.runAllTimersAsync();
    expect(injected).toHaveLength(0);
    expect(log).toContain('print'); // still prints — just to a sheet
  });

  it('leaves the sheet alone when nothing laid out', async () => {
    bodyHeight = 0;
    win = makeWindow();
    beginPrintWindow().render('<p>bill</p>');
    await vi.runAllTimersAsync();
    // A 0mm page would print nothing at all; a sheet at least prints.
    expect(injected).toHaveLength(0);
    expect(log).toContain('print');
  });
});
