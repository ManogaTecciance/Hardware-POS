import type { Prisma, Supplier } from '@hardware-pos/database';

import type { SupplierDto } from './suppliers.types';

function toNumber(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toSupplierDto(s: Supplier): SupplierDto {
  return {
    id: s.id,
    name: s.name,
    company: s.company,
    email: s.email,
    phone: s.phone,
    mobile: s.mobile,
    fax: s.fax,
    website: s.website,
    street: s.street,
    city: s.city,
    province: s.province,
    postalCode: s.postalCode,
    country: s.country,
    openingBalance: toNumber(s.openingBalance),
    openingBalanceDate: iso(s.openingBalanceDate),
    taxId: s.taxId,
    isActive: s.isActive,
    quickbooks: {
      status: s.qbStatus,
      vendorId: s.quickbooksVendorId,
      vendorName: s.quickbooksVendorName,
      lastSyncedAt: iso(s.qbLastSyncedAt),
    },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
