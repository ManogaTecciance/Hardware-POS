import type { SupplierQbStatus } from '@hardware-pos/database';

/**
 * Response shapes for the supplier API — a strict mirror of the QuickBooks
 * Online Vendor template fields plus system fields. Mirrors the frontend
 * contract in `apps/web/src/lib/suppliers/types.ts`; keep the two in step.
 */

export interface SupplierQuickBooksDto {
  status: SupplierQbStatus;
  vendorId: string | null;
  vendorName: string | null;
  lastSyncedAt: string | null;
}

export interface SupplierDto {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  /** Province / Region / State. */
  province: string | null;
  postalCode: string | null;
  country: string | null;
  /** Opening balance as entered (QuickBooks owns the live A/P balance). */
  openingBalance: number | null;
  openingBalanceDate: string | null;
  taxId: string | null;
  isActive: boolean;
  quickbooks: SupplierQuickBooksDto;
  createdAt: string;
  updatedAt: string;
}
