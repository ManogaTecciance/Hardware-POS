/**
 * ItemDiscountDialog — per-line discount at the counter.
 *
 * The load-bearing rules from Section 9 of the counter-POS spec:
 *   * Percentage AND fixed amounts are supported.
 *   * A reason is captured.
 *   * A percentage over the role limit is refused — the CTA is disabled.
 *   * Original / discount / new-item-total are all displayed so the
 *     cashier does not have to calculate mentally.
 *
 * Every negative below is paired with a positive control so a component
 * that always/never rendered the button would fail.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DraftLine } from '../pos-types';
import { ItemDiscountDialog } from './item-discount-dialog';

afterEach(cleanup);

function line(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'k1',
    menuItemId: 'm1',
    name: 'Mix Kottu',
    unitPrice: '1000',
    quantity: 2,
    specialInstructions: '',
    modifiers: [],
    ...overrides,
  };
}

describe('ItemDiscountDialog', () => {
  it('applies a percentage discount and calls onApply with the type + value', () => {
    const onApply = vi.fn();
    render(
      <ItemDiscountDialog line={line()} roleLimit={null} onApply={onApply} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/percentage/i), { target: { value: '10' } });
    screen.getByRole('button', { name: /apply discount/i }).click();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: 'PERCENTAGE', value: 10 }),
    );
  });

  it('applies a fixed amount discount', () => {
    const onApply = vi.fn();
    render(
      <ItemDiscountDialog line={line()} roleLimit={null} onApply={onApply} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fixed amount/i }));
    fireEvent.change(
      document.getElementById('discount-value') as HTMLInputElement,
      { target: { value: '250' } },
    );
    screen.getByRole('button', { name: /apply discount/i }).click();
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FIXED', value: 250 }),
    );
  });

  it('rejects an over-limit percentage when the role limit is set', () => {
    // Cashier role limit is 0% in ROLE_DISCOUNT_LIMIT_PERCENT — even 1%
    // should be blocked at this dialog until a manager approves.
    render(
      <ItemDiscountDialog line={line()} roleLimit={0} onApply={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/percentage/i), { target: { value: '10' } });
    const cta = screen.getByRole('button', { name: /apply discount/i });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    // The warning names the role limit so the cashier isn't left guessing.
    expect(document.body.textContent).toMatch(/exceeds your role limit/i);
  });

  it('accepts a percentage inside the role limit (positive control)', () => {
    render(
      <ItemDiscountDialog line={line()} roleLimit={15} onApply={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/percentage/i), { target: { value: '10' } });
    const cta = screen.getByRole('button', { name: /apply discount/i });
    expect((cta as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(/exceeds your role limit/i);
  });

  it('shows Original / Discount / New item total so the cashier does not calculate', () => {
    render(
      <ItemDiscountDialog
        line={line({ quantity: 2, unitPrice: '1000' })}
        roleLimit={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/percentage/i), { target: { value: '10' } });
    // Line subtotal 2000; 10% = 200; new total = 1800.
    expect(document.body.textContent).toMatch(/Original/);
    expect(document.body.textContent).toMatch(/Discount/);
    expect(document.body.textContent).toMatch(/New item total/);
    expect(document.body.textContent).toMatch(/1,800/);
  });

  it('exposes Remove discount when the line already carries one', () => {
    const onApply = vi.fn();
    render(
      <ItemDiscountDialog
        line={line({ discount: { type: 'PERCENTAGE', value: 10 } })}
        roleLimit={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    screen.getByRole('button', { name: /remove discount/i }).click();
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it('refuses a fixed discount larger than the line subtotal', () => {
    render(
      <ItemDiscountDialog
        line={line({ quantity: 1, unitPrice: '500' })}
        roleLimit={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fixed amount/i }));
    fireEvent.change(document.getElementById('discount-value') as HTMLInputElement, {
      target: { value: '9999' },
    });
    expect((screen.getByRole('button', { name: /apply discount/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toMatch(/cannot exceed the line subtotal/i);
  });
});
