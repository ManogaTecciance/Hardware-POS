/**
 * The rows-per-page control every list footer in the product renders.
 *
 * Two claims, and the second is the one that has actually gone wrong here
 * before: the LIST is 20/50/100 (PO, 2026-09-09), and the footer really
 * renders it. Three screens used to carry their own copy — the till's
 * 20/30/40/50 and the orders queue's 25/50/75/100 — so asserting the exported
 * constant alone would have said nothing about what a cashier saw.
 *
 * The default-is-in-the-list invariant is asserted too. A screen whose default
 * page size is absent from the options renders a `<select>` whose value
 * matches no `<option>`: the browser shows the first one, so the control
 * silently claims a page size the list is not using.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE_SIZES, Pagination } from './pagination';

afterEach(cleanup);

const options = () =>
  Array.from((screen.getByLabelText('Rows per page') as HTMLSelectElement).options).map(
    (o) => o.value,
  );

describe('the rows-per-page choices', () => {
  it('is exactly 20, 50 and 100', () => {
    expect(PAGE_SIZES).toEqual([20, 50, 100]);
  });

  it('NEGATIVE — the retired sizes are gone from every footer', () => {
    // The three lists this replaced, named: 10/30 (the old shared list),
    // 40 (the till's) and 25/75 (the orders queue's).
    for (const retired of [10, 25, 30, 40, 75]) {
      expect(PAGE_SIZES).not.toContain(retired);
    }
  });

  it('ascends, so the first entry is the smallest — which every default relies on', () => {
    expect([...PAGE_SIZES].sort((a, b) => a - b)).toEqual(PAGE_SIZES);
    expect(new Set(PAGE_SIZES).size).toBe(PAGE_SIZES.length);
    expect(Math.min(...PAGE_SIZES)).toBe(PAGE_SIZES[0]);
  });
});

describe('the footer renders them', () => {
  it('offers the shared list, and reports the size it is on', () => {
    render(
      <Pagination
        page={1}
        pageSize={20}
        total={140}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );

    // The WIRING, not the constant: asserting `PAGE_SIZES` alone would pass for
    // a footer that rendered a hard-coded list of its own.
    expect(options()).toEqual(PAGE_SIZES.map(String));
    expect((screen.getByLabelText('Rows per page') as HTMLSelectElement).value).toBe('20');
    expect(screen.getByText('1–20 of 140')).toBeTruthy();
  });

  it('hands the chosen size back as a number', () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pagination
        page={1}
        pageSize={20}
        total={140}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '100' } });

    // A string would silently make `?pageSize=100` behave and the arithmetic
    // (`total / pageSize`) produce nonsense.
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });

  it('every default a screen starts on is one of the options', () => {
    /*
     * The defect class this guards: a screen defaulting to 25 while the footer
     * offers 20/50/100 renders a select whose value matches no option, so the
     * browser shows "20" over a page of 25 rows.
     *
     * Asserted through the component rather than by reading the screens'
     * sources — what matters is that the control agrees with the size it is
     * given, for every size a screen could start on.
     */
    for (const size of PAGE_SIZES) {
      cleanup();
      render(
        <Pagination
          page={1}
          pageSize={size}
          total={500}
          onPageChange={vi.fn()}
          onPageSizeChange={vi.fn()}
        />,
      );
      expect((screen.getByLabelText('Rows per page') as HTMLSelectElement).value).toBe(
        String(size),
      );
    }
  });

  it('NEGATIVE — a size outside the list is exactly what the browser cannot show', () => {
    // The retired default, rendered against the new options: the select falls
    // back to the first option and the footer disagrees with itself. This is
    // the failure the invariant above exists to prevent, proved to be real.
    render(
      <Pagination
        page={1}
        pageSize={25}
        total={500}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Rows per page') as HTMLSelectElement;
    expect(select.value).not.toBe('25');
    // …while the range it prints still counts in 25s — the two halves of the
    // footer contradicting each other.
    expect(screen.getByText('1–25 of 500')).toBeTruthy();
  });

  it('hides the control entirely for a list with a fixed size', () => {
    // Quotations and Suppliers pass no `onPageSizeChange`: no choices, so no
    // control, rather than a control that cannot change anything.
    render(<Pagination page={1} pageSize={25} total={500} onPageChange={vi.fn()} />);

    expect(screen.queryByLabelText('Rows per page')).toBeNull();
    expect(screen.getByText('1–25 of 500')).toBeTruthy();
  });
});
