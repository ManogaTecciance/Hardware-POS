import type { DocumentProfile } from '@/lib/document-template-service';
import type { ThermalBillInput } from '@/lib/thermal-bill';
import type { BillSampleKind } from '@/lib/settings/document-presentation';

/**
 * A sample bill for the Settings preview.
 *
 * ## Why it is per kind of trade (D153)
 *
 * The sample is what the operator actually inspects: whether the logo is too
 * wide, whether the note reads right, whether a long name wraps badly. A bill
 * full of somebody else's trade answers none of that, and it looks like a
 * bug — a clothing shop previewing "Grilled Seer" beside a service charge is
 * being shown a restaurant's bill with their name on it.
 *
 * D152 gave retail a thermal bill, so this list stopped being read only by
 * restaurants — which is how the food catalogue came to be shown to a shop.
 *
 * ## What differs beyond the names
 *
 * A retail bill has **no service charge** and **no table**, and those are not
 * cosmetic: a preview showing a service-charge row to a shop is previewing a
 * line their bill will never print, and a table number on a counter sale is
 * meaningless. The retail sample also carries a variant (a size) and a
 * fractional weight, because those ARE the two things a retail bill shows
 * that a restaurant one does not.
 *
 * Every optional total is otherwise filled deliberately. A sample with no
 * discount and no tax renders none of those rows, so the operator previews a
 * bill missing precisely the lines they are most likely to be checking.
 *
 * `issuedAt` is a fixed date rather than `new Date()`: a preview that changes
 * every render cannot be asserted against, and the date is not what anyone is
 * previewing.
 */
type SampleLine = {
  name: string;
  variantName?: string;
  quantity: string;
  unit: number;
  note?: string;
};

const FOOD_SERVICE_LINES: SampleLine[] = [
  { name: 'Chicken Fried Rice', variantName: 'Large', quantity: '2.000', unit: 950 },
  { name: 'Devilled Cashew', quantity: '1.000', unit: 850, note: 'less chilli' },
  { name: 'Soup of the Day', quantity: '2.000', unit: 550 },
  { name: 'Grilled Seer', variantName: 'Half', quantity: '1.000', unit: 2400 },
  { name: 'Vegetable Kottu', quantity: '1.000', unit: 1100 },
  { name: 'Lime Soda', quantity: '3.000', unit: 350 },
  { name: 'Chocolate Biscuit Pudding', quantity: '2.000', unit: 750 },
  { name: 'Black Coffee', quantity: '2.000', unit: 300 },
];

/**
 * A shop's basket: groceries and clothing together, because RETAIL is one
 * business type covering both (Q12 resolved not to split it), and a sample
 * that showed only one would look wrong to half the workspaces that see it.
 *
 * The rice is priced by weight and the shirt carries a size, so the preview
 * exercises the two rows a retail bill has that a restaurant's does not.
 */
const RETAIL_LINES: SampleLine[] = [
  { name: 'Cotton Shirt — Blue', variantName: 'Medium', quantity: '2.000', unit: 3450 },
  { name: 'Basmati Rice (per kg)', quantity: '2.500', unit: 720 },
  { name: 'Ladies Denim Jeans', variantName: '32', quantity: '1.000', unit: 6900 },
  { name: 'Coconut Oil 1L', quantity: '3.000', unit: 1180 },
  { name: 'Kids T-Shirt', variantName: '5-6 yrs', quantity: '2.000', unit: 1650 },
  { name: 'Red Lentils (per kg)', quantity: '1.750', unit: 640 },
  { name: 'Bath Towel — Large', quantity: '1.000', unit: 2250 },
  { name: 'Milk Powder 400g', quantity: '2.000', unit: 1490 },
];

export function buildSampleBill(
  profile: DocumentProfile,
  currency: string,
  lineCount: number,
  kind: BillSampleKind = 'FOOD_SERVICE',
): ThermalBillInput {
  const foodService = kind === 'FOOD_SERVICE';
  const catalogue = foodService ? FOOD_SERVICE_LINES : RETAIL_LINES;

  const rows = Array.from({ length: Math.max(1, lineCount) }, (_, i) => catalogue[i % catalogue.length]!);
  const money = (n: number) => n.toFixed(2);
  const lineTotals = rows.map((r) => Number(r.quantity) * r.unit);
  const subtotal = lineTotals.reduce((sum, n) => sum + n, 0);
  const discount = Math.round(subtotal * 0.05 * 100) / 100;
  // A shop charges no service charge, so previewing that row would be
  // previewing a line its bill will never print.
  const serviceCharge = foodService
    ? Math.round((subtotal - discount) * 0.1 * 100) / 100
    : 0;
  const tax = Math.round((subtotal - discount + serviceCharge) * 0.08 * 100) / 100;
  const total = Math.round((subtotal - discount + serviceCharge + tax) * 100) / 100;

  return {
    profile,
    currency,
    documentNumber: 'S-000123',
    // A table and a server are things a restaurant bill names. A counter
    // sale has neither, and printing an empty label is worse than none.
    placeLabel: foodService ? 'M1/04' : null,
    servedBy: foodService ? 'Nimal' : null,
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
