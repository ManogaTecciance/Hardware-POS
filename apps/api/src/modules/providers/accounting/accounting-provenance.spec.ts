import { AccountingProviderKind, SyncStatus } from '@hardware-pos/database';

import { AmbiguousAccountingProvenanceError, ProviderErrorCode } from '../provider.errors';
import {
  externalWriters,
  returnAccountingProvenance,
  saleAccountingProvenance,
} from './accounting-provenance';

/** A sale as QuickBooks leaves it. */
const quickbooksSale = {
  id: 'sale-qb',
  quickbooksDocumentType: 'SALES_RECEIPT' as const,
  quickbooksDocumentId: null,
  syncStatus: 'PENDING' as SyncStatus,
};

/** A sale as `NoAccountingProvider` leaves it. */
const localSale = {
  id: 'sale-local',
  quickbooksDocumentType: null,
  quickbooksDocumentId: null,
  syncStatus: 'NOT_SYNCED' as SyncStatus,
};

describe('sale accounting provenance', () => {
  it('reads QUICKBOOKS from a stored external document type', () => {
    expect(saleAccountingProvenance(quickbooksSale)).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('reads NONE from the absence of one', () => {
    expect(saleAccountingProvenance(localSale)).toBe(AccountingProviderKind.NONE);
  });

  it('still reads QUICKBOOKS once the sale has been pushed and has an external id', () => {
    expect(
      saleAccountingProvenance({
        ...quickbooksSale,
        quickbooksDocumentId: 'QBO-SR-S-000001',
        syncStatus: 'SYNCED',
      }),
    ).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('reads QUICKBOOKS for an INVOICE sale as well as a SALES_RECEIPT', () => {
    expect(
      saleAccountingProvenance({ ...quickbooksSale, quickbooksDocumentType: 'INVOICE' }),
    ).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('still reads QUICKBOOKS for a sale whose push FAILED — provenance is not sync state', () => {
    expect(saleAccountingProvenance({ ...quickbooksSale, syncStatus: 'FAILED' })).toBe(
      AccountingProviderKind.QUICKBOOKS,
    );
  });

  // ── fail closed ──────────────────────────────────────────────────────────

  it('refuses a sale with an external id but no external document type', () => {
    expect(() =>
      saleAccountingProvenance({ ...localSale, quickbooksDocumentId: 'QBO-SR-S-000009' }),
    ).toThrow(AmbiguousAccountingProvenanceError);
  });

  it.each<SyncStatus>(['PENDING', 'SYNCING', 'SYNCED', 'FAILED'])(
    'refuses a sale with no document type but sync status %s',
    (syncStatus) => {
      expect(() => saleAccountingProvenance({ ...localSale, syncStatus })).toThrow(
        AmbiguousAccountingProvenanceError,
      );
    },
  );

  it('refuses evidence that is missing entirely rather than inferring QuickBooks', () => {
    // A partially-populated object must not satisfy `!== null` and be read as
    // external. This is the inference the module exists to prevent.
    const incomplete = { id: 'sale-x' } as never;
    expect(() => saleAccountingProvenance(incomplete)).toThrow(AmbiguousAccountingProvenanceError);
  });

  it('names the entity, its id and the contradiction, and carries a machine-readable code', () => {
    try {
      saleAccountingProvenance({ ...localSale, quickbooksDocumentId: 'QBO-SR-1' });
      fail('expected a refusal');
    } catch (err) {
      const e = err as AmbiguousAccountingProvenanceError;
      expect(e.code).toBe(ProviderErrorCode.AMBIGUOUS_ACCOUNTING_PROVENANCE);
      expect(e.getStatus()).toBe(409);
      expect(e.message).toContain('sale sale-local');
      expect(e.message).toContain('external document id but no external document type');
      // No secret ever reaches a message.
      expect(e.message).not.toMatch(/token|realm|secret|password/i);
    }
  });
});

describe('return accounting provenance', () => {
  it('reads QUICKBOOKS from a stored return document type', () => {
    expect(
      returnAccountingProvenance({
        id: 'ret1',
        quickbooksDocumentType: 'CREDIT_MEMO',
        quickbooksDocumentId: null,
        syncStatus: 'PENDING',
      }),
    ).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('reads NONE from the absence of one', () => {
    expect(
      returnAccountingProvenance({
        id: 'ret2',
        quickbooksDocumentType: null,
        quickbooksDocumentId: null,
        syncStatus: 'NOT_SYNCED',
      }),
    ).toBe(AccountingProviderKind.NONE);
  });

  it('refuses a contradictory return row', () => {
    expect(() =>
      returnAccountingProvenance({
        id: 'ret3',
        quickbooksDocumentType: null,
        quickbooksDocumentId: 'QBO-CM-R-000001',
        syncStatus: 'SYNCED',
      }),
    ).toThrow(AmbiguousAccountingProvenanceError);
  });
});

describe('forward compatibility', () => {
  /**
   * Provenance is inferred as "external → the one external provider". That holds
   * only while exactly one external provider has an implementation.
   */
  it('has exactly one implemented external writer today', () => {
    expect(externalWriters()).toEqual([AccountingProviderKind.QUICKBOOKS]);
  });

  it('classifies every AccountingProviderKind, so a new one cannot slip through', () => {
    // `EXTERNAL_DOCUMENT_WRITERS` is a Record over the enum, so a new member is a
    // compile error. This asserts the enum itself has not grown a member that was
    // added somewhere else and defaulted here.
    expect(Object.values(AccountingProviderKind).sort()).toEqual(
      ['FUTURE_EXTERNAL', 'NONE', 'QUICKBOOKS'].sort(),
    );
  });

  it('FUTURE_EXTERNAL is not treated as a writer, because it has no implementation', () => {
    // `AccountingProviderFactory` throws for it, so no row can have been filed
    // under it. When it gains an implementation this must flip to true — and
    // `externalWriters()` will then return two, making provenance refuse to guess
    // rather than silently misfile documents.
    expect(externalWriters()).not.toContain(AccountingProviderKind.FUTURE_EXTERNAL);
  });
});
