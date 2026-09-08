import {
  billBodyGeometryCss,
  billGeometryMetaTags,
  type BillGeometry,
} from '@/lib/thermal-bill-geometry';

/**
 * D99 — the calibration strip: the instrument that ends the guessing.
 *
 * ## Why this exists
 *
 * D73 through D80 set the roll's geometry seven times, each round a guess sent
 * to the PO, printed, photographed and reported back. Every one of those
 * rounds was an attempt to measure a printer from a laptop. This prints a
 * ruler instead, so an operator measures their own printer in one page — and,
 * because Chrome and Edge place the page box differently, their own BROWSER
 * with it.
 *
 * ## Why it prints what it prints
 *
 * One strip has to answer three separate questions, and the first element is
 * what separates them. The outer bar reaches past the insets to the page's
 * own edges; everything below it is inset like the bill. So:
 *
 * - outer bar short on both sides → the PAGE is wider than the stock,
 * - outer bar intact but ruler numerals missing → the INSETS are too small,
 * - and which side lost them says which inset.
 *
 * Without the outer bar those two faults look identical on paper, which is
 * how D79 spent a round narrowing the page when the inset was the problem.
 */

/** The body rule is shared with the bill, and that is the point. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The browser family, for the strip's own label.
 *
 * The order is not alphabetical and cannot be: every Chromium browser claims
 * to be Chrome in its user agent, and Edge claims to be both, so the specific
 * tokens have to be tried first. Unrecognised returns null rather than a best
 * guess — see `browserLabel` below for why a wrong label is worse than none.
 */
export function detectBrowserLabel(userAgent: string): string | null {
  if (/\bEdg[A-Z]?\//.test(userAgent)) return 'Edge';
  if (/\bOPR\//.test(userAgent)) return 'Opera';
  if (/\bFirefox\//.test(userAgent)) return 'Firefox';
  // `HeadlessChrome/` has no word boundary before "Chrome", so `\bChrome\/`
  // misses it — and it then fell through to Safari, below.
  if (/Chrom(?:e|ium)\//.test(userAgent)) return 'Chrome';
  /*
   * Safari LAST, and only in the absence of any Chromium token. EVERY Chromium
   * user agent ends "Safari/537.36", so a bare `\bSafari\//` test labels Chrome
   * and Edge as Safari the moment the checks above miss — which is the one
   * outcome this function must not produce, since an operator would then
   * calibrate a browser they are not using.
   */
  if (/\bSafari\//.test(userAgent) && !/Chrom(?:e|ium)\//.test(userAgent)) return 'Safari';
  return null;
}

export interface BillTestStripInput {
  geometry: BillGeometry;
  /**
   * Which browser produced this strip. Two strips on a counter are otherwise
   * indistinguishable, and the whole defect is that two browsers disagree.
   *
   * Null prints an em dash, never a plausible guess (D54): an operator
   * comparing a strip labelled "Chrome" that came out of Edge would calibrate
   * the wrong browser and believe they had finished.
   */
  browserLabel: string | null;
}

/** Every 5mm, numbered every 10mm, across the CONTENT column. */
function ruler(contentWidthMm: number): string {
  const ticks: string[] = [];
  for (let mm = 0; mm <= Math.floor(contentWidthMm); mm += 5) {
    const major = mm % 10 === 0;
    ticks.push(
      `<span class="tick ${major ? 'maj' : ''}" style="left:${mm}mm">` +
        (major ? `<i>${mm}</i>` : '') +
        `</span>`,
    );
  }
  // A ruler with no ticks is a blank box that reads as a printer fault. It
  // cannot happen — the resolver guarantees a content column — and if it ever
  // does, say so on the paper rather than printing nothing.
  if (ticks.length === 0) return `<p class="warn">RULER EMPTY — geometry is invalid</p>`;
  return `<div class="ruler">${ticks.join('')}</div>`;
}

export function renderBillTestStrip(input: BillTestStripInput): string {
  const g = input.geometry;
  const browser = input.browserLabel ? esc(input.browserLabel) : '—';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Roll calibration</title>${billGeometryMetaTags(
    g,
  )}<style>
:root { color-scheme: light; }
*,*::before,*::after{box-sizing:border-box}
@page{margin:0}
html,body{height:auto}
@media screen{html{overflow:hidden}}
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;${billBodyGeometryCss(
    g,
  )};color:#000;background:#fff}
/*
 * The base size is a SEPARATE rule, deliberately. The rule above has to be
 * byte-identical to the bill's — that identity is what makes this a valid
 * instrument, and it is asserted as such — so nothing the strip needs for
 * itself may be appended to it.
 */
body{font-size:11px}
h1{font-size:13px;margin:6px 0 2px;text-align:center}
p{margin:2px 0}
/*
 * The one element that is NOT inset. Negative margins exactly equal to the
 * insets take it back out to the page box, so it shows where the PAGE ends
 * rather than where the text does.
 */
.pagebar{height:3mm;background:#000;margin:0 -${g.rightInsetMm}mm 4px -${g.leftInsetMm}mm}
.edges{display:flex;justify-content:space-between;font-weight:bold;margin-bottom:2px}
.ruler{position:relative;height:22px;border-top:1px solid #000;margin-bottom:6px}
.tick{position:absolute;top:0;width:0;border-left:1px solid #000;height:5px}
.tick.maj{height:9px}
.tick i{position:absolute;top:10px;left:-6px;width:12px;text-align:center;font-style:normal;font-size:8px}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;font-weight:normal}
th.q,td.q{text-align:center;width:34px}
th.a,td.a{text-align:right;width:74px;white-space:nowrap}
hr{border:0;border-top:1px dashed #000;margin:6px 0}
.how{font-size:9px;line-height:1.35}
.now{font-size:10px;font-weight:bold}
.warn{font-weight:bold}
</style></head>
<body>
<div class="pagebar"></div>
<h1>ROLL CALIBRATION</h1>

<div class="edges"><span>&#9664;L</span><span>R&#9654;</span></div>
${ruler(g.contentWidthMm)}

<hr>
<table>
<thead><tr><th>DESCRIPTION</th><th class="q">QTY</th><th class="a">AMOUNT</th></tr></thead>
<tbody><tr><td>Widest line this bill can print</td><td class="q">1</td><td class="a">LKR 1,450,000.00</td></tr></tbody>
</table>
<hr>

<p class="now">page ${g.pageWidthMm}mm &middot; left ${g.leftInsetMm}mm &middot; right ${
    g.rightInsetMm
  }mm &middot; content ${g.contentWidthMm}mm</p>
<p class="now">browser: ${browser}</p>

<div class="how">
<p>1. Solid bar at the top short on BOTH sides? Reduce Paper width by the larger loss.</p>
<p>2. Missing &#9664;L or low numbers gone? Raise Left inset past the first number you can read.</p>
<p>3. Missing R&#9654;, high numbers gone, or the amount not ending in .00? Raise Right inset the same way.</p>
<p>4. Print this from EVERY browser the till uses and keep the largest inset of each side.</p>
</div>
</body></html>`;
}
