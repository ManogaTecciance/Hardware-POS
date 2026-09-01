/**
 * D99 — the calibration strip.
 *
 * ## Why the first assertion is the important one
 *
 * The strip's job is to tell an operator what their printer and browser do to
 * a bill. It can only do that if it is laid out like a bill — same page cap,
 * same margins, same insets, to the character. A strip that is even 1mm
 * different measures itself. So the load-bearing test here is not "does it
 * print a ruler" but "is its body rule byte-identical to the bill's".
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_PROFILE } from '@/lib/document-template-service';
import { renderThermalBill, type ThermalBillInput } from '@/lib/thermal-bill';
import { billBodyGeometryCss, resolveBillGeometry } from '@/lib/thermal-bill-geometry';
import { detectBrowserLabel, renderBillTestStrip } from './bill-test-strip';

const bodyRuleOf = (html: string) =>
  html.slice(html.indexOf('body{font-family'), html.indexOf('}', html.indexOf('body{font-family')));

const billHtml = (profile: Partial<typeof DEFAULT_DOCUMENT_PROFILE>): string => {
  const input: ThermalBillInput = {
    profile: { ...DEFAULT_DOCUMENT_PROFILE, ...profile },
    currency: 'LKR',
    documentNumber: 'S-1',
    issuedAt: new Date('2026-07-15T13:40:00'),
    lines: [{ name: 'x', quantity: '1', lineTotal: '1.00' }],
    subtotal: '1.00',
    total: '1.00',
    paid: '1.00',
    balance: '0.00',
  };
  return renderThermalBill(input);
};

describe('the strip is laid out like the bill it measures', () => {
  for (const [name, profile] of [
    ['the shipped defaults', {}],
    ['a 58mm roll', { billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4 }],
  ] as const) {
    it(`has the bill's body rule, byte for byte — ${name}`, () => {
      const g = resolveBillGeometry({ ...DEFAULT_DOCUMENT_PROFILE, ...profile });
      const strip = renderBillTestStrip({ geometry: g, browserLabel: 'Edge' });

      // Byte-identical, both derived from the shared `billBodyGeometryCss`.
      expect(bodyRuleOf(strip)).toBe(bodyRuleOf(billHtml(profile)));
      // …and it really is the geometry's, not a coincidence of two constants.
      expect(bodyRuleOf(strip)).toContain(billBodyGeometryCss(g));
    });
  }
});

describe('what the strip prints', () => {
  const g = resolveBillGeometry(DEFAULT_DOCUMENT_PROFILE);
  const strip = renderBillTestStrip({ geometry: g, browserLabel: 'Edge' });

  it('states the numbers in force, so a photographed strip identifies itself', () => {
    expect(strip).toContain('page 78mm');
    expect(strip).toContain('left 3mm');
    expect(strip).toContain('right 5mm');
    expect(strip).toContain('content 70mm');
  });

  it('names the browser, because that is what the two strips differ by', () => {
    expect(strip).toContain('browser: Edge');
  });

  it('prints an em dash rather than a guess when the browser is unknown', () => {
    /*
     * D54 — a plausible default is worse than a blank. An operator comparing a
     * strip labelled "Chrome" that in fact came out of Edge would calibrate
     * the wrong browser and believe they had finished.
     */
    const anon = renderBillTestStrip({ geometry: g, browserLabel: null });
    expect(anon).toContain('browser: —');
    expect(anon).not.toContain('Chrome');
    expect(anon).not.toContain('Edge');
  });

  it('takes the page bar OUT to the page edges, and nothing else with it', () => {
    /*
     * This is the element that separates "the page is wider than the stock"
     * from "the insets are too small" — two faults that look identical on
     * paper, and telling them apart is what D79 spent a round failing to do.
     *
     * Negative margins exactly equal to the insets, so the bar reaches the
     * page box while every other element stays inset like the bill.
     */
    expect(strip).toContain(
      `.pagebar{height:3mm;background:#000;margin:0 -${g.rightInsetMm}mm 4px -${g.leftInsetMm}mm}`,
    );
    // Spelled out as a literal too, so the assertion above cannot pass by
    // interpolating whatever the module happens to emit.
    expect(strip).toContain('.pagebar{height:3mm;background:#000;margin:0 -5mm 4px -3mm}');
    // The ruler is NOT pulled out — it measures the text column.
    expect(strip).toContain('.ruler{position:relative');
    expect(strip).not.toMatch(/\.ruler\{[^}]*margin:0 -/);
  });

  it('rules the content column with ticks it actually emits', () => {
    // Positive: the ruler exists and reaches the far end of the column…
    const ticks = strip.match(/class="tick[^"]*" style="left:(\d+)mm"/g) ?? [];
    expect(ticks.length).toBeGreaterThan(10);
    const last = Math.max(
      ...ticks.map((t) => Number(/left:(\d+)mm/.exec(t)?.[1] ?? '-1')),
    );
    expect(last).toBeGreaterThanOrEqual(g.contentWidthMm - 5);
    // …and negative: no tick past the column, which would print off the paper
    // and read as a clip that is not there.
    expect(last).toBeLessThanOrEqual(g.contentWidthMm);
    // The analyser must not be inspecting nothing: a renamed class would give
    // zero matches and satisfy every "no tick beyond" claim on its own.
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('scales its ruler to the column rather than to a fixed 70mm', () => {
    const narrow = resolveBillGeometry({
      billPaperWidthMm: 58,
      billLeftInsetMm: 2,
      billRightInsetMm: 4,
    });
    const ticks = (h: string) => (h.match(/class="tick/g) ?? []).length;
    expect(ticks(renderBillTestStrip({ geometry: narrow, browserLabel: null }))).toBeLessThan(
      ticks(strip),
    );
  });

  it('carries the widest line a bill can print, at the right edge', () => {
    // The exact D80 failure: "LKR 1,450.00" came out as "LKR 1,450." If the
    // final digits are missing on paper, the right inset is short whatever the
    // ruler says.
    expect(strip).toContain('LKR 1,450,000.00');
    expect(strip).toContain('class="a"');
  });

  it('carries the geometry meta, so it prints on the bill’s own path', () => {
    expect(strip).toContain('<meta name="hpos:page-width-mm" content="78">');
  });

  it('tells Edge from Chrome, which is the distinction the strip exists for', () => {
    /*
     * Real user-agent strings, and Edge's is the one that matters: it contains
     * BOTH "Chrome/" and "Edg/", so an order that tested Chrome first would
     * label every Edge strip "Chrome" — and an operator would then calibrate
     * Chrome twice and never find out why the bill still clipped.
     */
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    const edge = `${chrome} Edg/140.0.0.0`;
    expect(detectBrowserLabel(chrome)).toBe('Chrome');
    expect(detectBrowserLabel(edge)).toBe('Edge');
    expect(detectBrowserLabel(`${chrome} OPR/120.0.0.0`)).toBe('Opera');
    expect(
      detectBrowserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'),
    ).toBe('Firefox');
    /*
     * Headless Chromium, which is what caught this: `HeadlessChrome/` has no
     * word boundary before "Chrome", so a `\bChrome\/` test misses it — and it
     * then fell through to the Safari branch, because every Chromium user
     * agent ends "Safari/537.36". A strip that says Safari when it came out of
     * Chrome is the exact failure this function exists to avoid.
     */
    expect(detectBrowserLabel(`${chrome.replace('Chrome/', 'HeadlessChrome/')}`)).toBe('Chrome');
    expect(detectBrowserLabel(edge)).not.toBe('Safari');
    expect(detectBrowserLabel(chrome)).not.toBe('Safari');

    // Real Safari, which carries no Chromium token at all — the positive that
    // stops the guard above from simply deleting Safari detection.
    expect(
      detectBrowserLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      ),
    ).toBe('Safari');

    // NEGATIVE: an unknown agent is not guessed at (D54).
    expect(detectBrowserLabel('curl/8.4.0')).toBeNull();
    expect(detectBrowserLabel('')).toBeNull();
  });

  it('carries no script and no on-page button', () => {
    // Same rule as the bill (D78): it is written into an invisible frame, so a
    // stray script would run unseen.
    expect(strip).not.toContain('<script');
    expect(strip).not.toContain('window.print()');
  });
});
