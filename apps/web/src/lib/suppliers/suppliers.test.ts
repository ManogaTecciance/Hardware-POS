import { describe, expect, it } from 'vitest';

import { Permission } from '@/lib/permissions';
import { deriveSupplierAccess } from './access';
import { formatBalance, formatDateOnly, formatLocation, supplierInitials } from './format';
import { QB_STATUS_LABELS, qbBadgeVariant, type SupplierQbStatus } from './types';

describe('deriveSupplierAccess', () => {
  it('grants nothing without supplier permissions', () => {
    const access = deriveSupplierAccess([Permission.SALE_READ]);
    expect(access).toEqual({
      canView: false,
      canManage: false,
      canDelete: false,
      canMapQuickBooks: false,
    });
  });

  it('maps each permission to its capability', () => {
    const access = deriveSupplierAccess([
      Permission.SUPPLIER_READ,
      Permission.SUPPLIER_MANAGE,
      Permission.SUPPLIER_DELETE,
      Permission.SUPPLIER_QB_MAP,
    ]);
    expect(access).toEqual({
      canView: true,
      canManage: true,
      canDelete: true,
      canMapQuickBooks: true,
    });
  });

  it('read-only roles view without managing', () => {
    const access = deriveSupplierAccess([Permission.SUPPLIER_READ, Permission.SUPPLIER_QB_MAP]);
    expect(access.canView).toBe(true);
    expect(access.canManage).toBe(false);
    expect(access.canDelete).toBe(false);
    expect(access.canMapQuickBooks).toBe(true);
  });
});

describe('qb status presentation', () => {
  it('labels every status', () => {
    const statuses: SupplierQbStatus[] = ['CONNECTED', 'WAITING', 'ATTENTION', 'NOT_CONNECTED'];
    for (const s of statuses) {
      expect(QB_STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it('uses distinct, semantically-correct badge variants', () => {
    expect(qbBadgeVariant('CONNECTED')).toBe('success');
    expect(qbBadgeVariant('WAITING')).toBe('warning');
    expect(qbBadgeVariant('ATTENTION')).toBe('danger');
    expect(qbBadgeVariant('NOT_CONNECTED')).toBe('neutral');
  });
});

describe('supplierInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(supplierInitials('Lanka Hardware Distributors')).toBe('LH');
    expect(supplierInitials('Acme')).toBe('A');
  });

  it('survives extra whitespace', () => {
    expect(supplierInitials('  Kolupaev   Whole Sale ')).toBe('KW');
  });
});

describe('formatBalance', () => {
  it('never fabricates a zero for unknown values', () => {
    expect(formatBalance(null)).toBe('—');
    expect(formatBalance(undefined, 'Unavailable')).toBe('Unavailable');
  });

  it('formats real values as money', () => {
    expect(formatBalance(0)).not.toBe('—');
    expect(formatBalance(250000)).toContain('250,000');
  });
});

describe('formatLocation', () => {
  it('joins the parts that exist', () => {
    expect(formatLocation('Colombo', 'Western', 'Sri Lanka')).toBe('Colombo, Western, Sri Lanka');
    expect(formatLocation('Colombo', null, 'Sri Lanka')).toBe('Colombo, Sri Lanka');
    expect(formatLocation(null, null, null)).toBe('—');
  });
});

describe('formatDateOnly', () => {
  it('shows a readable date for ISO input', () => {
    expect(formatDateOnly('2026-01-01T00:00:00.000Z')).toMatch(/2026/);
  });

  it('falls back for null or invalid input', () => {
    expect(formatDateOnly(null)).toBe('—');
    expect(formatDateOnly('not-a-date')).toBe('—');
  });
});
