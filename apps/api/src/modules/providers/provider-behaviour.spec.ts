/**
 * Provider behaviour that needs no database: the no-op providers, and the
 * document-type rules.
 *
 * The document-type assertions are copied from the *current* code, not re-derived:
 * `sales.service` decides `paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE'`
 * and `returns.service.resolveQboDocType` decides `STORE_CREDIT → CREDIT_MEMO`,
 * else paid → `REFUND_RECEIPT`, else `CREDIT_MEMO`. If an assertion here has to
 * change, the provider has changed behaviour and Slice 5 is no longer inert.
 */

import { AccountingProviderKind, InventoryMode, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { NoAccountingProvider } from './accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from './accounting/quickbooks-accounting.provider';
import { NoInventoryProvider } from './inventory/no-inventory.provider';
import type { ProviderContext } from './provider.types';

const CTX: ProviderContext = { tenantId: 'tnt_a', branchId: 'br_a' };

/**
 * A transaction client that fails loudly if touched.
 *
 * Passed to every no-op so "it is a no-op" is proven rather than assumed: if an
 * implementation ever reached for `tx.product` or `tx.syncJob`, this throws.
 */
function forbiddenTx(): Prisma.TransactionClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`No-op provider must not touch tx.${String(property)}`);
      },
    },
  ) as Prisma.TransactionClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// NoInventoryProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('NoInventoryProvider', () => {
  const provider = new NoInventoryProvider();

  it('reports DISABLED', () => {
    expect(provider.mode).toBe(InventoryMode.DISABLED);
  });

  it('reports every product as unlimited, explicitly', () => {
    return provider.getAvailability(CTX, ['p1', 'p2']).then((map) => {
      expect(map.size).toBe(2);
      for (const productId of ['p1', 'p2']) {
        expect(map.get(productId)).toEqual({
          productId,
          trackInventory: false,
          // null rather than 0: zero would make a caller refuse the sale.
          quantityOnHand: null,
          isUnlimited: true,
        });
      }
    });
  });

  it('reports availability for every id asked about, so an absence is never ambiguous', async () => {
    const map = await provider.getAvailability(CTX, ['p1', 'p1', 'p2']);
    expect([...map.keys()].sort()).toEqual(['p1', 'p2']);
  });

  it.each([
    ['reduceStock', (tx: Prisma.TransactionClient) => provider.reduceStock(tx, CTX, [])],
    ['restoreStock', (tx: Prisma.TransactionClient) => provider.restoreStock(tx, CTX, [])],
    ['adjustStock', (tx: Prisma.TransactionClient) => provider.adjustStock(tx, CTX, [])],
  ])('%s never touches the transaction client', async (_name, call) => {
    await expect(call(forbiddenTx())).resolves.toBeUndefined();
  });

  it('is a no-op even when given real lines — it must not behave like Local', async () => {
    const lines = [
      { productId: 'p1', productName: 'Tile', quantity: 5, trackInventory: true },
      { productId: 'p2', productName: 'Grout', quantity: 2, trackInventory: true },
    ];
    // trackInventory: true would move stock under Local; here it must not, and the
    // forbidden proxy proves nothing was read or written.
    await expect(provider.reduceStock(forbiddenTx(), CTX, lines)).resolves.toBeUndefined();
    await expect(provider.restoreStock(forbiddenTx(), CTX, lines)).resolves.toBeUndefined();
  });

  it('is deterministic across repeated calls', async () => {
    const first = await provider.getAvailability(CTX, ['p1']);
    const second = await provider.getAvailability(CTX, ['p1']);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('never claims a synchronisation happened', async () => {
    const outcome = await provider.synchronize(CTX);
    expect(outcome.requested).toBe(false);
    expect(outcome.queued).toBe(0);
    expect(outcome.detail).toMatch(/disabled/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NoAccountingProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('NoAccountingProvider', () => {
  const provider = new NoAccountingProvider();

  it('reports NONE', () => {
    expect(provider.provider).toBe(AccountingProviderKind.NONE);
  });

  it.each([['UNPAID'], ['PARTIAL'], ['PAID']] as const)(
    'resolves NO sale document type for a %s sale',
    (paymentStatus) => {
      expect(
        provider.resolveSaleDocumentType({ paymentStatus, hasCustomer: false, total: 1000 }),
      ).toEqual({ documentType: null, requiresCustomer: false });
    },
  );

  it('never requires a customer — the QuickBooks Invoice rule does not apply', () => {
    // This is the abstraction earning its keep: a restaurant running a tab for an
    // unnamed walk-in must not be blocked by an accounting rule about CustomerRef.
    const decision = provider.resolveSaleDocumentType({
      paymentStatus: 'UNPAID',
      hasCustomer: false,
      total: 1000,
    });
    expect(decision.requiresCustomer).toBe(false);
  });

  it.each([['CASH'], ['STORE_CREDIT'], ['CARD']])(
    'resolves NO return document type for a %s refund',
    (refundMethod) => {
      expect(
        provider.resolveReturnDocumentType({ originalPaymentStatus: 'PAID', refundMethod }),
      ).toEqual({ documentType: null, requiresCustomer: false });
    },
  );

  it('never fabricates a QuickBooks document id', () => {
    const serialised = JSON.stringify([
      provider.resolveSaleDocumentType({ paymentStatus: 'PAID', hasCustomer: true, total: 1 }),
      provider.resolveReturnDocumentType({ originalPaymentStatus: 'PAID', refundMethod: 'CASH' }),
    ]);
    expect(serialised).not.toMatch(/QBO-|quickbooksDocumentId|SR-|INV-/);
  });

  it.each([
    ['postSale', (tx: Prisma.TransactionClient) => provider.postSale(tx, CTX, 'sal_1', null)],
    ['postReturn', (tx: Prisma.TransactionClient) => provider.postReturn(tx, CTX, 'ret_1', null)],
  ])('%s never touches the transaction client, so no SyncJob or SyncLog can be written', async (
    _name,
    call,
  ) => {
    await expect(call(forbiddenTx())).resolves.toBeDefined();
  });

  it('never claims a synchronisation happened', async () => {
    const outcome = await provider.synchronize(CTX);
    expect(outcome.requested).toBe(false);
    expect(outcome.queued).toBe(0);
  });

  // ── Decision 1: NOT_REQUIRED semantics ──────────────────────────────────

  it('postSale reports NOT_REQUIRED / NONE / no external document type', async () => {
    await expect(provider.postSale(forbiddenTx(), CTX, 'sal_1', null)).resolves.toEqual({
      disposition: 'NOT_REQUIRED',
      provider: 'NONE',
      externalDocumentType: null,
    });
  });

  it('postReturn reports NOT_REQUIRED / NONE / no external document type', async () => {
    await expect(provider.postReturn(forbiddenTx(), CTX, 'ret_1', null)).resolves.toEqual({
      disposition: 'NOT_REQUIRED',
      provider: 'NONE',
      externalDocumentType: null,
    });
  });

  it('never reports QUEUED, so no caller can read it as a successful push', async () => {
    const results = [
      await provider.postSale(forbiddenTx(), CTX, 'sal_1', null),
      await provider.postReturn(forbiddenTx(), CTX, 'ret_1', null),
    ];
    for (const result of results) {
      expect(result.disposition).not.toBe('QUEUED');
      expect(result.provider).not.toBe('QUICKBOOKS');
    }
  });

  it('ignores a document type handed to it anyway — it cannot fabricate one', async () => {
    // Defensive: this provider's resolver always returns null, but if a caller ever
    // passed a type through, honouring it would invent an external document for a
    // tenant with no external system.
    const result = await provider.postSale(forbiddenTx(), CTX, 'sal_1', 'SALES_RECEIPT');
    expect(result.externalDocumentType).toBeNull();
    expect(result.disposition).toBe('NOT_REQUIRED');
  });

  it('the result carries no secret and no provider-specific detail', async () => {
    const serialised = JSON.stringify(await provider.postSale(forbiddenTx(), CTX, 'sal_1', null));
    expect(Object.keys(JSON.parse(serialised) as object).sort()).toEqual([
      'disposition',
      'externalDocumentType',
      'provider',
    ]);
    expect(serialised).not.toMatch(/token|secret|realm|password|credential/i);
  });

  it('the ambiguous "synced with no document" shape is not representable', async () => {
    // The reason Decision 1 exists: `{ markSynced: true, documentType: null }` could
    // be read either way, and the safe-looking reading was the wrong one.
    const result = await provider.postSale(forbiddenTx(), CTX, 'sal_1', null);
    expect(result).not.toHaveProperty('markSynced');
    expect(result).not.toHaveProperty('synced');
    // Disposition and document type always agree.
    expect(result.disposition === 'NOT_REQUIRED' && result.externalDocumentType === null).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QuickBooksAccountingProvider — document types, characterised
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickBooksAccountingProvider document types', () => {
  const syncQueue = {
    enqueueSaleSync: jest.fn().mockResolvedValue(undefined),
    enqueueReturnSync: jest.fn().mockResolvedValue(undefined),
  } as unknown as SyncQueueService;
  const prisma = { syncJob: { count: jest.fn().mockResolvedValue(0) } } as unknown as PrismaService;
  const provider = new QuickBooksAccountingProvider(syncQueue, prisma);

  beforeEach(() => jest.clearAllMocks());

  it('reports QUICKBOOKS', () => {
    expect(provider.provider).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('a fully PAID sale is a SALES_RECEIPT needing no customer', () => {
    expect(
      provider.resolveSaleDocumentType({ paymentStatus: 'PAID', hasCustomer: false, total: 1000 }),
    ).toEqual({ documentType: 'SALES_RECEIPT', requiresCustomer: false });
  });

  it.each([['UNPAID'], ['PARTIAL']] as const)('a %s sale is an INVOICE needing a customer', (
    paymentStatus,
  ) => {
    expect(
      provider.resolveSaleDocumentType({ paymentStatus, hasCustomer: true, total: 1000 }),
    ).toEqual({ documentType: 'INVOICE', requiresCustomer: true });
  });

  it('states the customer requirement rather than throwing', () => {
    // The caller keeps raising its own existing user-facing error with its existing
    // wording, which is what makes Slice 6 a pure extraction.
    expect(() =>
      provider.resolveSaleDocumentType({
        paymentStatus: 'UNPAID',
        hasCustomer: false,
        total: 1000,
      }),
    ).not.toThrow();
  });

  it('STORE_CREDIT is always a CREDIT_MEMO, even for a fully paid sale', () => {
    expect(
      provider.resolveReturnDocumentType({
        originalPaymentStatus: 'PAID',
        refundMethod: 'STORE_CREDIT',
      }).documentType,
    ).toBe('CREDIT_MEMO');
  });

  it.each([['CASH'], ['CARD'], ['BANK_TRANSFER'], ['QR_PAYMENT'], ['CHECK']])(
    'a PAID sale refunded by %s is a REFUND_RECEIPT',
    (refundMethod) => {
      expect(
        provider.resolveReturnDocumentType({ originalPaymentStatus: 'PAID', refundMethod })
          .documentType,
      ).toBe('REFUND_RECEIPT');
    },
  );

  it.each([['UNPAID'], ['PARTIAL']] as const)(
    'a %s (credit) sale refunded in cash is a CREDIT_MEMO',
    (originalPaymentStatus) => {
      expect(
        provider.resolveReturnDocumentType({ originalPaymentStatus, refundMethod: 'CASH' })
          .documentType,
      ).toBe('CREDIT_MEMO');
    },
  );

  it('delegates postSale to the existing queue, inside the caller transaction', async () => {
    const tx = {} as Prisma.TransactionClient;
    await provider.postSale(tx, CTX, 'sal_1', 'SALES_RECEIPT');

    // Delegation, not reimplementation — this is what guarantees the persisted
    // SyncJob and SyncLog shapes cannot drift from what the repositories write.
    expect(syncQueue.enqueueSaleSync).toHaveBeenCalledWith(tx, 'tnt_a', 'sal_1');
  });

  it('delegates postReturn to the existing queue, inside the caller transaction', async () => {
    const tx = {} as Prisma.TransactionClient;
    await provider.postReturn(tx, CTX, 'ret_1', 'REFUND_RECEIPT');
    expect(syncQueue.enqueueReturnSync).toHaveBeenCalledWith(tx, 'tnt_a', 'ret_1');
  });

  it('passes the tenant from the context, never from anywhere else', async () => {
    await provider.postSale(
      {} as Prisma.TransactionClient,
      { tenantId: 'tnt_z', branchId: null },
      's',
      'INVOICE',
    );
    expect(syncQueue.enqueueSaleSync).toHaveBeenCalledWith(expect.anything(), 'tnt_z', 's');
  });

  // ── Decision 1: QUEUED semantics ────────────────────────────────────────

  it.each([['SALES_RECEIPT'], ['INVOICE']] as const)(
    'postSale reports QUEUED / QUICKBOOKS / %s',
    async (documentType) => {
      await expect(
        provider.postSale({} as Prisma.TransactionClient, CTX, 'sal_1', documentType),
      ).resolves.toEqual({
        disposition: 'QUEUED',
        provider: 'QUICKBOOKS',
        externalDocumentType: documentType,
      });
    },
  );

  it.each([['REFUND_RECEIPT'], ['CREDIT_MEMO']] as const)(
    'postReturn reports QUEUED / QUICKBOOKS / %s',
    async (documentType) => {
      await expect(
        provider.postReturn({} as Prisma.TransactionClient, CTX, 'ret_1', documentType),
      ).resolves.toEqual({
        disposition: 'QUEUED',
        provider: 'QUICKBOOKS',
        externalDocumentType: documentType,
      });
    },
  );

  it('refuses a null document type rather than inventing one', async () => {
    // QuickBooks always resolves a type, so null is a wiring mistake. Substituting a
    // default would misfile a real financial record.
    await expect(
      provider.postSale({} as Prisma.TransactionClient, CTX, 'sal_1', null),
    ).rejects.toThrow(/does not support/);
    expect(syncQueue.enqueueSaleSync).not.toHaveBeenCalled();
  });

  it('refuses a null return document type too', async () => {
    await expect(
      provider.postReturn({} as Prisma.TransactionClient, CTX, 'ret_1', null),
    ).rejects.toThrow(/does not support/);
    expect(syncQueue.enqueueReturnSync).not.toHaveBeenCalled();
  });

  it('reports nothing pending as requested: false', async () => {
    await expect(provider.synchronize(CTX)).resolves.toMatchObject({
      requested: false,
      queued: 0,
    });
  });
});
