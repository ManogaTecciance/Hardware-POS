/**
 * The brand mark, and which asset each theme actually gets.
 *
 * The defect this pins: the app chrome used ONE asset, `axlo-icon.svg`, whose
 * chevrons are filled `#fff`. On the dark rail that reads; on the light rail
 * (`bg-surface` resolves to white) the chevrons vanish and the logo becomes a
 * bare gradient slash. The manifest PNG is the same mark drawn `#000718`, i.e.
 * the light-surface twin.
 *
 * Asserted as the CSS contract rather than by measuring pixels: the swap is a
 * `dark:` variant bound to `[data-theme='dark']` (globals.css), so what is
 * provable in jsdom is that exactly one copy is marked visible per theme, and
 * that the two are the two different files. Both directions, because a
 * component that rendered the same asset twice would satisfy either half
 * alone.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandMark } from './brand-mark';

afterEach(cleanup);

const marks = () => Array.from(document.querySelectorAll('img'));

const DISPLAY_UTILITIES = new Set(['block', 'inline-block', 'inline', 'flex', 'grid', 'hidden']);

/**
 * Whether a class string leaves the element displayed under a theme.
 *
 * A RESOLVER, not a whitelist. The first version asked "does it carry
 * `dark:block`", which cannot notice the likeliest regression of all — the
 * light copy losing its `dark:hidden`, leaving both marks displayed in dark.
 * Mutation-proved below: that spelling of the check passed every mutant.
 *
 * Applies the display utilities in source order, skipping variants that do not
 * match the theme, exactly as the cascade does for Tailwind's equal-specificity
 * variant rules. An element with no display utility keeps the `img` default,
 * which is displayed — so a copy that loses `hidden` reads as shown, which is
 * the point.
 */
function displayedIn(className: string, theme: 'light' | 'dark'): boolean {
  let display: string | null = null;
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const colon = token.lastIndexOf(':');
    const variant = colon === -1 ? null : token.slice(0, colon);
    const utility = colon === -1 ? token : token.slice(colon + 1);
    if (!DISPLAY_UTILITIES.has(utility)) continue;
    // Only the theme variants decide this contract; `print:` is asserted
    // separately, and any other variant does not apply on screen.
    if (variant !== null && variant !== 'dark') continue;
    if (variant === 'dark' && theme !== 'dark') continue;
    display = utility;
  }
  return display !== 'hidden';
}

/** The asset(s) actually displayed under a theme. */
function shownIn(theme: 'light' | 'dark'): string[] {
  return marks()
    .filter((img) => displayedIn(img.className, theme))
    .map((img) => img.getAttribute('src') ?? '');
}

describe('which asset each theme gets', () => {
  it('shows the dark-inked mark in light, and the white one in dark', () => {
    render(<BrandMark className="h-9 w-auto" />);

    // The trimmed PNG is inked #000718 — it reads on the white light surface.
    expect(shownIn('light')).toEqual(['/brand/axlo-icon-light.png']);
    // The SVG fills its chevrons #fff — it reads on the #1a2433 dark surface.
    expect(shownIn('dark')).toEqual(['/brand/axlo-icon.svg']);
  });

  it('NEGATIVE — never both at once, and never the same file twice', () => {
    render(<BrandMark />);

    expect(shownIn('light')).toHaveLength(1);
    expect(shownIn('dark')).toHaveLength(1);
    // Two copies of one asset would pass every "is visible" check above while
    // leaving one theme with an invisible logo — the original defect exactly.
    expect(new Set(marks().map((i) => i.getAttribute('src'))).size).toBe(2);
  });

  it('sizes both copies identically, so a theme flip does not resize the mark', () => {
    render(<BrandMark className="h-9 w-auto shrink-0" />);

    for (const img of marks()) {
      expect(img.className).toContain('h-9');
      expect(img.className).toContain('w-auto');
      expect(img.className).toContain('shrink-0');
    }
  });
});

describe('the resolver this spec depends on', () => {
  /*
   * MUTATION PROOF (D30). `displayedIn` is an analyser, so it needs its own
   * evidence: the whitelist it replaced ("has dark:block") passed every one of
   * these, which is how a spec can go green over a logo that is invisible in
   * one theme.
   */
  it('reads the shipped pair correctly, both ways', () => {
    expect(displayedIn('block dark:hidden print:block h-9', 'light')).toBe(true);
    expect(displayedIn('block dark:hidden print:block h-9', 'dark')).toBe(false);
    expect(displayedIn('hidden dark:block print:hidden h-9', 'light')).toBe(false);
    expect(displayedIn('hidden dark:block print:hidden h-9', 'dark')).toBe(true);
  });

  it('catches a copy that lost its opposite-theme rule', () => {
    // The light copy without `dark:hidden` stays displayed in dark…
    expect(displayedIn('block h-9', 'dark')).toBe(true);
    // …and the dark copy without `hidden` is displayed in light.
    expect(displayedIn('dark:block h-9', 'light')).toBe(true);
    // The old whitelist said the opposite for both, which is why it passed
    // mutants: it asked about the class list, not about the outcome.
    expect(['block h-9'.includes('dark:block'), true]).toEqual([false, true]);
  });

  it('ignores utilities that are not about display', () => {
    expect(displayedIn('h-9 w-auto shrink-0 md:h-12', 'light')).toBe(true);
  });
});

describe('the two assets stay interchangeable', () => {
  it('carry the same ink aspect, so one class sizes them alike', async () => {
    /*
     * The invariant the whole trimmed asset exists for. Read from the FILES,
     * because nothing else can catch the regression that started this: pointing
     * the light copy back at a padded PWA icon leaves every other assertion
     * here green while the mark renders a third smaller in light mode.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const publicDir = join(process.cwd(), 'public', 'brand');

    // PNG: width and height are big-endian 32-bit at bytes 16..24 of the IHDR.
    const png = readFileSync(join(publicDir, 'axlo-icon-light.png'));
    const pngAspect = png.readUInt32BE(16) / png.readUInt32BE(20);

    const svg = readFileSync(join(publicDir, 'axlo-icon.svg'), 'utf8');
    const viewBox = /viewBox="([\d.\s]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
    const svgAspect = viewBox![2]! / viewBox![3]!;

    expect(pngAspect).toBeCloseTo(svgAspect, 2);
    // POSITIVE CONTROL — the untrimmed PWA icon is square, so this comparison
    // really does discriminate rather than passing on any two files.
    expect(Math.abs(1 - svgAspect)).toBeGreaterThan(0.4);
  });
});

describe('what a screen reader hears', () => {
  it('is silent by default — the product name sits beside it as text', () => {
    render(<BrandMark />);

    for (const img of marks()) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('takes a name when it is the only thing identifying the product', () => {
    render(<BrandMark alt="Axlo POS" />);

    // Both copies carry it; only the displayed one reaches the a11y tree, since
    // `display: none` removes the other.
    const named = marks().filter((i) => i.getAttribute('alt') === 'Axlo POS');
    expect(named).toHaveLength(2);
    for (const img of named) expect(img.getAttribute('aria-hidden')).toBeNull();
  });
});
