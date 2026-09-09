/**
 * The counter POS bill card — what each deduction says it is.
 *
 * ## What was wrong
 *
 * The promotion row printed the bare offer name. It sits in the same column as
 * "Item discounts", "Service charge" and "Tax", so "Lunch 10%" read as a
 * mystery deduction — the operator could see money coming off and not what
 * kind of thing had taken it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The wording case asserts the labelled form is present AND that the bare name
 * is not, in one render: "contains Lunch 10%" would pass for the broken
 * version, since the labelled string contains it too. The zero case is the
 * paired negative — a row rendered unconditionally would claim a discount
 * nobody was given — and the manual-discount case proves the two deductions
 * stay distinguishable rather than collapsing into one row.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/labels', () => ({
  formatMoney: (v: string | number) => `LKR ${Number(v).toFixed(2)}`,
}));

const { RunningBillSummary } = await import('./running-bill-summary');

type Props = React.ComponentProps<typeof RunningBillSummary>;

function card(over: Partial<Props> = {}) {
  const props: Props = {
    itemCount: 3,
    subtotal: 3000,
    itemDiscount: 0,
    promotionDiscount: 0,
    promotionName: null,
    serviceCharge: 0,
    taxAmount: 0,
    servicePct: 0,
    taxPct: 0,
    total: 3000,
    ...over,
  };
  return render(<RunningBillSummary {...props} />);
}

afterEach(cleanup);

describe('the promotion row', () => {
  it('says it is a promotion, not just the offer’s name', async () => {
    card({ promotionDiscount: 250, promotionName: 'Lunch 10%', total: 2750 });

    // POSITIVE: the wording the receipt and the A4 bill have used since D123,
    // through the same shared formatter.
    expect(screen.getByText('Promotion: Lunch 10%')).toBeTruthy();
    // NEGATIVE: and not the bare name. This arm is the one that fails against
    // the version being replaced — the positive alone would too, since the old
    // label is a substring of the new one under a loose matcher.
    expect(screen.queryByText('Lunch 10%')).toBeNull();
    expect(screen.getByText('- LKR 250.00')).toBeTruthy();
  });

  it('falls back to a plain label when no single promotion can be named', () => {
    // Several stackable offers have no one honest name, so the workspace
    // passes null rather than picking one.
    card({ promotionDiscount: 400, promotionName: null, total: 2600 });

    expect(screen.getByText('Promotion')).toBeTruthy();
    expect(screen.getByText('- LKR 400.00')).toBeTruthy();
  });

  it('is absent when no promotion applied', () => {
    card({ promotionDiscount: 0, promotionName: 'Lunch 10%' });

    // A name with no discount is not a discount. Rendering the row anyway
    // would tell the operator money came off when none did.
    expect(screen.queryByText(/^Promotion/)).toBeNull();
  });

  it('stays a separate row from a manual item discount', () => {
    card({ itemDiscount: 100, promotionDiscount: 250, promotionName: 'Lunch 10%', total: 2650 });

    // Two different things — one a cashier chose and may need approval for,
    // one the offer gave automatically — so they never collapse into one line.
    expect(screen.getByText('Item discounts')).toBeTruthy();
    expect(screen.getByText('- LKR 100.00')).toBeTruthy();
    expect(screen.getByText('Promotion: Lunch 10%')).toBeTruthy();
    expect(screen.getByText('- LKR 250.00')).toBeTruthy();
  });
});
