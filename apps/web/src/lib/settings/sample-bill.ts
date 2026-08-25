import type { DocumentProfile } from '@/lib/document-template-service';
import type { ThermalBillInput } from '@/lib/thermal-bill';

/**
 * A sample bill for the Settings preview.
 *
 * There is no restaurant sample catalogue anywhere in the product — the
 * server's `SAMPLE_ITEMS` is a hardware list (Portland cement, billed to a
 * construction company), which is why a restaurant owner opening Preview today
 * sees a quotation for building materials.
 *
 * Every optional total is filled deliberately. A sample with no discount, no
 * service charge and no tax renders none of those rows, so the operator
 * previews a bill that is missing precisely the lines they are most likely to
 * be checking the wording of.
 *
 * `issuedAt` is a fixed date rather than `new Date()`: a preview that changes
 * every render cannot be asserted against, and the date is not what anyone is
 * previewing.
 */
export function buildSampleBill(
  profile: DocumentProfile,
  currency: string,
  lineCount: number,
): ThermalBillInput {
  const catalogue: { name: string; variantName?: string; quantity: string; unit: number; note?: string }[] = [
    { name: 'Chicken Fried Rice', variantName: 'Large', quantity: '2.000', unit: 950 },
    { name: 'Devilled Cashew', quantity: '1.000', unit: 850, note: 'less chilli' },
    { name: 'Soup of the Day', quantity: '2.000', unit: 550 },
    { name: 'Grilled Seer', variantName: 'Half', quantity: '1.000', unit: 2400 },
    { name: 'Vegetable Kottu', quantity: '1.000', unit: 1100 },
    { name: 'Lime Soda', quantity: '3.000', unit: 350 },
    { name: 'Chocolate Biscuit Pudding', quantity: '2.000', unit: 750 },
    { name: 'Black Coffee', quantity: '2.000', unit: 300 },
  ];

  const rows = Array.from({ length: Math.max(1, lineCount) }, (_, i) => catalogue[i % catalogue.length]!);
  const money = (n: number) => n.toFixed(2);
  const lineTotals = rows.map((r) => Number(r.quantity) * r.unit);
  const subtotal = lineTotals.reduce((sum, n) => sum + n, 0);
  const discount = Math.round(subtotal * 0.05 * 100) / 100;
  const serviceCharge = Math.round((subtotal - discount) * 0.1 * 100) / 100;
  const tax = Math.round((subtotal - discount + serviceCharge) * 0.08 * 100) / 100;
  const total = Math.round((subtotal - discount + serviceCharge + tax) * 100) / 100;

  return {
    profile,
    currency,
    documentNumber: 'S-000123',
    placeLabel: 'M1/04',
    servedBy: 'Nimal',
    cashierName: 'Kamala',
    issuedAt: new Date('2026-07-15T13:40:00'),
    lines: rows.map((r, i) => ({
      name: r.name,
      variantName: r.variantName ?? null,
      quantity: r.quantity,
      lineTotal: money(lineTotals[i]!),
      specialInstructions: r.note ?? null,
    })),
    subtotal: money(subtotal),
    discount: money(discount),
    serviceCharge: money(serviceCharge),
    tax: money(tax),
    total: money(total),
    paid: money(total),
    balance: '0.00',
    payments: [{ method: 'CASH', amount: money(total) }],
    // Matches what the real bill screens do — the note comes off the profile.
    note: profile.billNote || null,
  };
}
