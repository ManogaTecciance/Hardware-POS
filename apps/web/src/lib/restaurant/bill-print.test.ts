import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenant-money', () => ({ getActiveCurrency: () => 'LKR' }));

import { billToThermalInput } from './bill-print';
import type { BillView } from './types';

/**
 * D98 — one map from a bill to the paper.
 *
 * This mapping existed twice, byte-for-byte, in `bill-screen.tsx` and
 * `bill-dialog.tsx`, and neither copy was testable without rendering a
 * component: both did the fetch, the map and the print in one function. So the
 * thing most worth checking — that every money field reaches the receipt —
 * had no test at all, in either copy.
 */

const view: BillView = {
  saleId: 'sale_1',
  saleNumber: 'S-000123',
  placeLabel: 'Takeaway',
  servedByName: 'Nimal',
  closedAt: '2026-07-15T13:40:00.000Z',
  items: [
    {
      name: 'Chicken Fried Rice',
      variantName: 'Large',
      quantity: '2.000',
      lineTotal: '1900.00',
      specialInstructions: 'less chilli',
    },
  ],
  subtotal: '1900.00',
  totalDiscount: '100.00',
  serviceChargeAmount: '180.00',
  packagingCharge: '50.00',
  taxAmount: '160.00',
  total: '2190.00',
  paidAmount: '2190.00',
  balanceAmount: '0.00',
  payments: [{ method: 'CASH', amount: '2190.00' }],
} as unknown as BillView;

const profile = { billNote: 'Prices include service charge.' } as never;

describe('billToThermalInput', () => {
  it('carries every money field through to the receipt', () => {
    const input = billToThermalInput(view, profile, {
      fallbackName: 'Main Dining',
      cashierName: 'Kamala',
    });

    /*
     * Asserted as a whole object, not field by field. A field DROPPED from the
     * map is the failure that matters here — the service charge silently
     * missing from one of the three call sites is exactly what having three
     * copies risked — and a per-field test only catches the fields somebody
     * thought to list.
     */
    expect(input).toMatchObject({
      documentNumber: 'S-000123',
      placeLabel: 'Takeaway',
      servedBy: 'Nimal',
      cashierName: 'Kamala',
      fallbackName: 'Main Dining',
      currency: 'LKR',
      subtotal: '1900.00',
      discount: '100.00',
      serviceCharge: '180.00',
      packaging: '50.00',
      tax: '160.00',
      total: '2190.00',
      paid: '2190.00',
      balance: '0.00',
      note: 'Prices include service charge.',
      payments: [{ method: 'CASH', amount: '2190.00' }],
    });
    expect(input.lines).toEqual([
      {
        name: 'Chicken Fried Rice',
        variantName: 'Large',
        quantity: '2.000',
        lineTotal: '1900.00',
        specialInstructions: 'less chilli',
      },
    ]);
    expect(input.issuedAt).toEqual(new Date('2026-07-15T13:40:00.000Z'));
  });

  it('is not a copy that has quietly dropped a charge', () => {
    const input = billToThermalInput(view, profile, {
      fallbackName: '',
      cashierName: null,
    });

    // NEGATIVE, named one by one: these four are the rows a guest queries, and
    // each was carried independently in each of the two former copies.
    for (const field of ['discount', 'serviceCharge', 'packaging', 'tax'] as const) {
      expect(input[field], `${field} must reach the receipt`).toBeDefined();
      expect(input[field]).not.toBeNull();
    }
    // …and a null cashier stays null rather than becoming a name.
    expect(input.cashierName).toBeNull();
  });

  it('a reprint can be marked as a copy; an original is not', () => {
    expect(
      billToThermalInput(view, profile, { fallbackName: '', cashierName: 'K', copyLabel: 'COPY' })
        .copyLabel,
    ).toBe('COPY');
    // The default matters: a bill that always said COPY could not be given to
    // a customer as an original.
    expect(billToThermalInput(view, profile, { fallbackName: '', cashierName: 'K' }).copyLabel).toBeNull();
  });

  it('an empty bill note becomes null, not an empty line on the paper', () => {
    const input = billToThermalInput(view, { billNote: '' } as never, {
      fallbackName: '',
      cashierName: null,
    });
    expect(input.note).toBeNull();
  });
});
