/**
 * @vitest-environment jsdom
 */
/**
 * D99 — the printed document and the print frame agree, by construction.
 *
 * ## The defect this guards
 *
 * `printReceipt` is handed an HTML STRING. The stylesheet inside that string
 * decides how wide the text prints; the frame the string is written into
 * decides how wide it LAYS OUT, and the page height written into `@page` is
 * measured from that layout. Two numbers, produced in two files, that must
 * match — and for seven rounds (D73–D80) they were kept matching by hand.
 *
 * The geometry now travels inside the document and the frame reads it back, so
 * this spec asserts the property rather than the arithmetic: render a bill at a
 * geometry that is NOT the default, print it, and require the frame, the
 * stylesheet and the injected page to agree on that geometry and on nothing
 * else.
 *
 * ## Why 58/2/4
 *
 * Every assertion here would also pass against a `printReceipt` that ignored
 * the document and used a hard-coded 78mm — IF the fixture were the default.
 * 58/2/4 shares no digit with 78/3/5, and 58mm is 219px against the default's
 * 295px, so a hard-coded printer cannot produce these numbers by accident.
 * The mutation proof at the bottom asserts exactly that distinction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', async () => {
  const actual = await vi.importActual<typeof import('./document-template-service')>(
    './document-template-service',
  );
  return { ...actual, getCachedDocumentProfile: () => actual.DEFAULT_DOCUMENT_PROFILE };
});
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => String(v) }));
vi.mock('./restaurant/labels', () => ({ formatMoney: (v: number | string) => String(v) }));
vi.mock('./products-api', () => ({ resolveImageUrl: (u: string | null) => u }));

import { DEFAULT_DOCUMENT_PROFILE } from './document-template-service';
import { renderThermalBill, type ThermalBillInput } from './thermal-bill';
import { mmToPx } from './thermal-bill-geometry';

let opened = 0;
let injected: string[] = [];
let frameStyle = '';
let styleAtMeasureTime = '';
const BODY_HEIGHT_PX = 1000;

/**
 * A frame backed by a real parsed document, so `readBillGeometry` runs against
 * a genuine `querySelector` rather than a stub that could be taught to answer.
 */
function fakeFrame() {
  let doc: Document = new DOMParser().parseFromString('<html></html>', 'text/html');
  const win = {
    focus: () => {},
    print: () => {},
    addEventListener: () => {},
    get document() {
      return doc;
    },
  };
  const shim = {
    open: () => {},
    write: (h: string) => {
      doc = new DOMParser().parseFromString(h, 'text/html');
    },
    close: () => {},
    get images() {
      return [] as unknown[];
    },
    get body() {
      return {
        // Recorded when the height is read: the frame must ALREADY be at the
        // document's width by then, or the measurement is taken against the
        // provisional default and the error is invisible on a 78mm roll.
        get scrollHeight() {
          styleAtMeasureTime = frameStyle;
          return BODY_HEIGHT_PX;
        },
      };
    },
    documentElement: { scrollHeight: 0 },
    createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
    head: {
      appendChild: (el: unknown) => injected.push((el as { textContent: string }).textContent),
    },
    querySelector: (sel: string) => doc.querySelector(sel),
  };
  Object.defineProperty(win, 'document', { get: () => shim as unknown as Document });
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
    contentDocument: shim,
    remove: () => {},
  };
}

const bill = (profile: Partial<typeof DEFAULT_DOCUMENT_PROFILE>): string => {
  const input: ThermalBillInput = {
    profile: { ...DEFAULT_DOCUMENT_PROFILE, ...profile },
    currency: 'LKR',
    documentNumber: 'S-000057',
    issuedAt: new Date('2026-07-15T13:40:00'),
    lines: [{ name: 'CHKN F/RCE/S', quantity: '1', lineTotal: '1450000.00' }],
    subtotal: '1450000.00',
    total: '1450000.00',
    paid: '1450000.00',
    balance: '0.00',
  };
  return renderThermalBill(input);
};

const realDocument = globalThis.document;

beforeEach(() => {
  vi.useFakeTimers();
  opened = 0;
  injected = [];
  frameStyle = '';
  styleAtMeasureTime = '';

  const frame = fakeFrame();
  vi.stubGlobal('document', {
    createElement: () => frame,
    body: { appendChild: () => {} },
  });
  vi.stubGlobal('window', {
    // D79's regression guard, restated here rather than assumed: the whole
    // class of "the receipt window will not close" comes back the moment
    // anything in this module opens one.
    open: () => {
      opened += 1;
      return null;
    },
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
  vi.stubGlobal('DOMParser', (realDocument.defaultView as Window & typeof globalThis).DOMParser);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { printReceipt } = await import('./receipt-print');

/** The number the stylesheet actually printed at. */
function bodyPadding(html: string): string {
  const rule = html.slice(html.indexOf('body{font-family'), html.indexOf('}', html.indexOf('body{font-family')));
  return rule;
}

describe('the frame and the stylesheet come from the same geometry', () => {
  it('lays out, styles and pages a 58mm bill at 58mm', async () => {
    const html = bill({ billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4 });
    printReceipt(html);
    await vi.runAllTimersAsync();

    // 1. The frame laid out at the PAGE width, not the content width. 58mm is
    //    219px; the content column is 52mm and would be 197px, and feeding the
    //    frame that would apply the insets twice.
    expect(frameStyle).toContain(`width:${mmToPx(58)}px`);
    expect(frameStyle).toContain('width:219px');

    // 2. The stylesheet printed at the same geometry.
    expect(bodyPadding(html)).toContain('max-width:58mm');
    expect(bodyPadding(html)).toContain('padding:0 4mm 0 2mm');

    // 3. The injected page carried the same page width — an exact set, so a
    //    second injected rule fails rather than being averaged away.
    expect(injected).toEqual(['@page{size:58mm 267mm;margin:0}']);

    /*
     * 4. NEGATIVES: no default may survive anywhere in the chain. These are
     *    what fail if any of the three re-hardcodes a number.
     *
     *    Scoped to the body rule rather than the whole document on purpose —
     *    the stylesheet's own comments cite the default numbers as history,
     *    and a document-wide ban would be a test that breaks on prose.
     */
    expect(frameStyle).not.toContain('295px');
    expect(bodyPadding(html)).not.toContain('78mm');
    expect(bodyPadding(html)).not.toContain('5mm');
    expect(injected.join('')).not.toContain('78mm');

    // 5. And still no window, ever (D79).
    expect(opened).toBe(0);
  });

  it('sets the frame width BEFORE the height is measured', async () => {
    /*
     * The silent one. If the frame is still at the provisional 295px when
     * `scrollHeight` is read, the page height is measured against the wrong
     * column — more lines fit, fewer wraps, a receipt that prints short. It
     * shows on no 78mm roll, which is every roll this repo has ever tested on.
     */
    printReceipt(bill({ billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4 }));
    await vi.runAllTimersAsync();
    expect(styleAtMeasureTime).toContain('width:219px');
    expect(styleAtMeasureTime).not.toContain('width:295px');
  });

  it('MUTATION PROOF — a hard-coded printer could not pass the test above', () => {
    /*
     * Everything above is a statement about 58mm. It is only a proof that the
     * printer READS the document if 58mm is distinguishable from what a
     * hard-coded printer would produce. These two lines are that argument,
     * written down: the pre-D99 constant was 78mm/295px, and neither number
     * can be reached from the fixture.
     */
    const hardCoded = mmToPx(78);
    expect(hardCoded).toBe(295);
    expect(hardCoded).not.toBe(mmToPx(58));
  });

  it('leaves a document that carries no geometry exactly as it was', async () => {
    /*
     * The other half, and it is what keeps D16 true. A retail receipt, a
     * quotation and every server-rendered document carry no meta tags, and
     * they must lay out at the default width and — for `openPrintWindow` —
     * declare no page at all.
     *
     * Without this case the spec above could be satisfied by a printer that
     * always trusted the document and crashed on one that had nothing to say.
     */
    printReceipt('<html><head></head><body><p>retail receipt</p></body></html>');
    await vi.runAllTimersAsync();
    expect(frameStyle).toContain('width:295px');
    expect(injected).toEqual(['@page{size:78mm 267mm;margin:0}']);
  });

  it('honours a workspace that switched one-page fitting off', async () => {
    /*
     * D77 — `@page{size}` is a request, and a driver with a fixed maximum page
     * length refuses it and prints the bill SCALED DOWN instead. The way out is
     * a setting, and it has to reach the printer through the document like
     * everything else.
     */
    printReceipt(bill({ billFitToContent: false }));
    await vi.runAllTimersAsync();
    expect(injected).toEqual([]);
    // …but the frame still laid out properly, so this is not just "nothing ran".
    expect(frameStyle).toContain('width:295px');
  });
});
