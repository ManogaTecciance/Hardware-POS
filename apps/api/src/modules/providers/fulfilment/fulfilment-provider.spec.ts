/**
 * D61 — the fulfilment provider contract (convergence plan §13.1,
 * `fulfilment-provider-contract`).
 *
 * The claims: every FulfilmentKind maps to exactly one provider whose `kind`
 * matches its registry key (a mismatch would route one lifecycle's work unit
 * into another's settle path); a provider handed the WRONG work-unit shape
 * refuses loudly instead of settling garbage; and the immediate provider is
 * an honest pass-through, not a silent empty list.
 */
import { FulfilmentKind, Prisma } from '@hardware-pos/database';
import { FULFILMENT_KIND_VALUES } from '@hardware-pos/shared';

import type { ProjectedSaleItem } from '../../restaurant/settlement-projection';
import { ImmediateFulfilmentProvider } from './immediate-fulfilment.provider';
import { TableServiceFulfilmentProvider } from './table-service-fulfilment.provider';

const tx = {} as Prisma.TransactionClient;

const LINE: ProjectedSaleItem = {
  productId: 'prd_1',
  productVariantId: null,
  productName: 'Widget',
  variantNameSnapshot: null,
  unitPrice: new Prisma.Decimal('10.00'),
  quantity: new Prisma.Decimal(1),
  modifierTotal: new Prisma.Decimal(0),
  notes: null,
  sourceKind: 'RETAIL_CART' as never,
  sourceItemId: 'x',
  lineSubtotal: new Prisma.Decimal('10.00'),
  lineTotal: new Prisma.Decimal('10.00'),
  modifiers: [],
};

describe('the fulfilment kind registry is total and consistent', () => {
  it('the shared vocabulary and the Prisma enum agree', () => {
    expect([...FULFILMENT_KIND_VALUES].sort()).toEqual(Object.values(FulfilmentKind).sort());
  });

  it('each provider declares the kind it is registered under', () => {
    // The factory's Record<FulfilmentKind, …> makes a MISSING kind a compile
    // error; this pins the runtime half — a provider whose `kind` field lies
    // about its registry key.
    const immediate = new ImmediateFulfilmentProvider();
    const tableService = new TableServiceFulfilmentProvider(
      undefined as never, // DiningService — not reached by these assertions
    );
    expect(immediate.kind).toBe(FulfilmentKind.IMMEDIATE);
    expect(tableService.kind).toBe(FulfilmentKind.TABLE_SERVICE);
    expect(immediate.kind).not.toBe(tableService.kind);
  });
});

describe('providers refuse the wrong work-unit shape', () => {
  it('immediate refuses a table session; table service refuses a cart', async () => {
    const immediate = new ImmediateFulfilmentProvider();
    const tableService = new TableServiceFulfilmentProvider(undefined as never);

    await expect(
      immediate.collectSettlementLines(tx, 't1', { kind: 'TABLE_SESSION', sessionId: 's1' }),
    ).rejects.toThrow(/cannot settle a TABLE_SESSION/);
    await expect(
      tableService.collectSettlementLines(tx, 't1', { kind: 'CART', lines: [LINE] }),
    ).rejects.toThrow(/cannot settle a CART/);
    await expect(
      immediate.releaseResources(tx, 't1', { kind: 'TABLE_SESSION', sessionId: 's1' }),
    ).rejects.toThrow(/cannot release/);
  });
});

describe('the immediate provider is a pass-through, not an empty answer', () => {
  it('returns exactly the cart lines it was handed', async () => {
    const immediate = new ImmediateFulfilmentProvider();
    const lines = await immediate.collectSettlementLines(tx, 't1', {
      kind: 'CART',
      lines: [LINE],
    });
    // POSITIVE both ways: the line comes back, and it is THE line — a
    // provider quietly returning [] would satisfy a weaker assertion.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(LINE);
    expect(await immediate.releaseResources(tx, 't1', { kind: 'CART', lines: [] })).toEqual({});
  });
});
