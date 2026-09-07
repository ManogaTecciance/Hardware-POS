import { describe, expect, it } from 'vitest';

import { pageWindow } from '@/components/ui/pagination';

/**
 * The numbered page row. What it has to guarantee is that the first and last
 * page are always reachable and the row does not change width as you walk
 * through it — otherwise the button under the cursor moves between clicks.
 */
describe('the numbered page window', () => {
  it('lists every page when they all fit', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('always keeps the first and last page reachable', () => {
    for (const page of [1, 5, 20, 41, 42]) {
      const w = pageWindow(page, 42);
      expect(w[0]).toBe(1);
      expect(w[w.length - 1]).toBe(42);
    }
  });

  it('centres the current page in the middle of a long list', () => {
    expect(pageWindow(20, 42)).toEqual([1, null, 19, 20, 21, null, 42]);
  });

  it('spends the freed slots near the start rather than leaving a short row', () => {
    expect(pageWindow(2, 42)).toEqual([1, 2, 3, 4, null, 42]);
  });

  it('does the same near the end', () => {
    expect(pageWindow(41, 42)).toEqual([1, null, 39, 40, 41, 42]);
  });

  it('never repeats a page and never leaves a gap of one', () => {
    for (let page = 1; page <= 30; page++) {
      const w = pageWindow(page, 30);
      const numbers = w.filter((n): n is number => n !== null);
      expect(new Set(numbers).size).toBe(numbers.length);
      // A "…" standing in for a single page would be wider than the page itself.
      w.forEach((n, i) => {
        if (n !== null) return;
        const before = w[i - 1] as number;
        const after = w[i + 1] as number;
        expect(after - before).toBeGreaterThan(1);
      });
    }
  });

  it('holds a steady width once the list is long', () => {
    const widths = new Set([5, 10, 15, 20, 25].map((p) => pageWindow(p, 40).length));
    expect(widths.size).toBe(1);
  });

  it('copes with a single page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});
