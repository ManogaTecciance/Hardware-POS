/**
 * Display helpers for the QuickBooks-shaped customer address. Documents and
 * quotations render a single "billing address" line; the QB template splits
 * the address into Street / City / State / ZIP / Country.
 */

export interface CustomerAddressFields {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

/** "123 Main St, Colombo, Western 00100, Sri Lanka" — skips missing parts. */
export function customerAddressLine(c: CustomerAddressFields): string | null {
  const stateZip = [c.state, c.zip].filter(Boolean).join(' ');
  const line = [c.street, c.city, stateZip, c.country].filter(Boolean).join(', ');
  return line || null;
}
