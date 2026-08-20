import { EscPosBuilder } from '../escpos';

/**
 * D67 — the finalised bill, as bytes, for the CASHIER printer.
 *
 * Printed when a waiter closes/completes an order. The numbers come from the
 * Sale the close transaction already wrote — this template NEVER recomputes
 * money (D52/D59: one calculator owns that), it only lays out what the
 * settlement document says, so paper and screen cannot disagree.
 */
export interface BillTemplateData {
  companyName: string;
  addressLine: string | null;
  phone: string | null;
  taxNumber: string | null;
  currency: string;
  footer: string | null;

  saleNumber: string;
  placeLabel: string | null;
  staffName: string | null;
  closedAt: Date;
  copyLabel: string | null;

  items: {
    name: string;
    variantName: string | null;
    quantity: string;
    lineTotal: string;
  }[];

  subtotal: string;
  serviceCharge: string;
  packagingCharge: string;
  tax: string;
  total: string;
  paid: string;
  balance: string;
  payments: { method: string; amount: string }[];
}

export function renderBill(data: BillTemplateData, columns = 48): Buffer {
  const b = new EscPosBuilder(columns);
  const money = (v: string) => `${data.currency} ${v}`;
  b.init();

  b.align('center').bold(true).doubleSize(true).line(data.companyName);
  b.doubleSize(false).bold(false);
  if (data.addressLine) b.line(data.addressLine);
  if (data.phone) b.line(data.phone);
  if (data.taxNumber) b.line(`Tax No: ${data.taxNumber}`);
  if (data.copyLabel) b.line(data.copyLabel);
  b.line();

  b.align('left').hr();
  b.row(data.saleNumber, formatStamp(data.closedAt));
  if (data.placeLabel) b.row(data.placeLabel, data.staffName ?? '');
  else if (data.staffName) b.row('Served by', data.staffName);
  b.hr();

  for (const item of data.items) {
    const label = item.variantName ? `${item.name} (${item.variantName})` : item.name;
    b.line(label);
    b.row(`  ${trimQty(item.quantity)} x`, money(item.lineTotal));
  }

  b.hr();
  b.row('Subtotal', money(data.subtotal));
  // Zero rows are omitted, not printed as 0.00: a bill that lists a service
  // charge of zero invites the question "why am I being charged nothing?".
  if (nonZero(data.serviceCharge)) b.row('Service charge', money(data.serviceCharge));
  if (nonZero(data.packagingCharge)) b.row('Packaging', money(data.packagingCharge));
  if (nonZero(data.tax)) b.row('Tax', money(data.tax));

  b.bold(true).doubleSize(true);
  b.row('TOTAL', money(data.total));
  b.doubleSize(false).bold(false);

  for (const payment of data.payments) b.row(payment.method, money(payment.amount));
  if (data.payments.length > 0) b.row('Paid', money(data.paid));
  // An unsettled balance is the one thing the cashier must not miss.
  if (nonZero(data.balance)) b.bold(true).row('BALANCE DUE', money(data.balance)).bold(false);

  b.line();
  if (data.footer) b.align('center').line(data.footer);
  b.cut();
  return b.build();
}

function nonZero(value: string): boolean {
  return Number(value) !== 0;
}

function trimQty(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

function formatStamp(at: Date): string {
  const d = String(at.getDate()).padStart(2, '0');
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${d}/${m}/${at.getFullYear()} ${hh}:${mm}`;
}
