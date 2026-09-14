/**
 * D197 — the completion screen hands the cashier the number to say.
 *
 * The one thing a customer needs from this screen is the number they will
 * listen for. It used to be `Order #RO-000120 created` — six digits nobody
 * repeats aloud. Now the call number is the headline and a block of its own;
 * the RO- identifier sits under it, small. A delivery order gets no block:
 * the rider collects by the partner's reference, not by ours.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/labels', () => ({
  formatMoney: (v: string | number) => `LKR ${Number(v).toFixed(2)}`,
}));

const { OrderCompletionScreen } = await import('./order-completion-screen');

type Summary = React.ComponentProps<typeof OrderCompletionScreen>['summary'];

function summary(over: Partial<Summary> = {}): Summary {
  return {
    orderNumber: 'RO-000120',
    callNumber: 47,
    mode: 'TAKEAWAY',
    paidNow: true,
    change: null,
    method: 'CASH',
    saleId: 'sale_1',
    takeawayId: 'tk_1',
    receiptPrinted: true,
    ...over,
  } as Summary;
}

afterEach(cleanup);

describe('the number the cashier tells the customer (D197)', () => {
  it('headlines "#47" and shows it big, with the RO- number under it', () => {
    render(<OrderCompletionScreen summary={summary()} onNewOrder={vi.fn()} onViewOrder={vi.fn()} />);
    expect(screen.getByText('Order #47 created')).toBeTruthy();
    const block = screen.getByTestId('call-number');
    expect(block.textContent).toContain('#47');
    expect(block.textContent).toContain('RO-000120');
    // NEGATIVE — the title is the call tag, not the six digits.
    expect(screen.queryByText(/Order #RO-000120 created/)).toBeNull();
  });

  it('an order minted before D197 is titled by its RO- number and gets no call block', () => {
    render(
      <OrderCompletionScreen
        summary={summary({ callNumber: null })}
        onNewOrder={vi.fn()}
        onViewOrder={vi.fn()}
      />,
    );
    expect(screen.getByText('Order #RO-000120 created')).toBeTruthy();
    expect(screen.queryByTestId('call-number')).toBeNull();
    expect(screen.getByTestId('order-reference').textContent).toBe('RO-000120');
  });

  it('a delivery order shows no call block — the rider collects by the partner\'s reference', () => {
    render(
      <OrderCompletionScreen
        summary={summary({ mode: 'THIRD_PARTY', paidNow: false })}
        onNewOrder={vi.fn()}
        onViewOrder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('call-number')).toBeNull();
    // …but the permanent reference is still on the screen to look the order up by.
    expect(screen.getByTestId('order-reference').textContent).toBe('RO-000120');
  });
});
