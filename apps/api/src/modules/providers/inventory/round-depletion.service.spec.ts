import { InventoryMode, Prisma } from '@hardware-pos/database';

import { InventoryProviderFactory } from './inventory-provider.factory';
import { RoundDepletionService } from './round-depletion.service';

/**
 * D65 — the depletion engine's branching, held to D30 in both directions:
 * every kind that depletes is proven to (positively, with the exact lines),
 * and every kind that must NOT deplete is proven inert — including the
 * componentless COMPOSED_ITEM, whose "nothing happens" IS the decision.
 */

type ProductRow = { id: string; name: string; type: string; sellableKind: string };

function buildTx(opts: {
  products: ProductRow[];
  components?: {
    productId: string;
    componentProductId: string;
    quantity: string;
    wastageRate: string;
  }[];
  quantityOnHand?: string;
}) {
  const movements: Record<string, unknown>[] = [];
  const tx = {
    product: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(opts.products.filter((p) => where.id.in.includes(p.id))),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve({ quantityOnHand: new Prisma.Decimal(opts.quantityOnHand ?? '7') }),
      ),
    },
    productComponent: {
      findMany: jest.fn(({ where }: { where: { productId: { in: string[] } } }) =>
        Promise.resolve(
          (opts.components ?? [])
            .filter((c) => where.productId.in.includes(c.productId))
            .map((c) => ({
              productId: c.productId,
              componentProductId: c.componentProductId,
              quantity: new Prisma.Decimal(c.quantity),
              wastageRate: new Prisma.Decimal(c.wastageRate),
            })),
        ),
      ),
    },
    stockMovement: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return Promise.resolve(data);
      }),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, movements };
}

function buildService(mode: InventoryMode = InventoryMode.LOCAL) {
  const reduceStock = jest.fn().mockResolvedValue(undefined);
  const restoreStock = jest.fn().mockResolvedValue(undefined);
  const factory = {
    forTenant: jest.fn().mockResolvedValue({ mode, reduceStock, restoreStock }),
  } as unknown as InventoryProviderFactory;
  return { service: new RoundDepletionService(factory), reduceStock, restoreStock };
}

const ITEM = (productId: string | null, quantity = 2) => ({
  orderItemId: 'item-1',
  productId,
  quantity,
});

describe('RoundDepletionService.depleteSubmittedItems', () => {
  it('a STOCK_ITEM depletes itself 1:1 and writes the ORDER_ROUND movement', async () => {
    const { service, reduceStock } = buildService();
    const { tx, movements } = buildTx({
      products: [{ id: 'p1', name: 'Bottled Beer', type: 'Inventory', sellableKind: 'STOCK_ITEM' }],
    });
    await service.depleteSubmittedItems(tx, 't1', 'b1', [ITEM('p1')], 'user-1');

    expect(reduceStock).toHaveBeenCalledWith(
      tx,
      { tenantId: 't1', branchId: 'b1' },
      [{ productId: 'p1', productName: 'Bottled Beer', quantity: 2, trackInventory: true }],
    );
    expect(movements).toEqual([
      expect.objectContaining({
        productId: 'p1',
        delta: new Prisma.Decimal(-2),
        balanceAfter: new Prisma.Decimal('7'),
        reason: 'ORDER_ROUND',
        refType: 'RESTAURANT_ORDER_ITEM',
        refId: 'item-1',
        branchId: 'b1',
        createdByUserId: 'user-1',
      }),
    ]);
  });

  it('a COMPOSED_ITEM with a recipe depletes its components with wastage, one level', async () => {
    const { service, reduceStock } = buildService();
    const { tx, movements } = buildTx({
      products: [
        { id: 'dish', name: 'Burger', type: 'Inventory', sellableKind: 'COMPOSED_ITEM' },
        { id: 'bun', name: 'Bun', type: 'Inventory', sellableKind: 'STOCK_ITEM' },
        { id: 'patty', name: 'Patty', type: 'Inventory', sellableKind: 'STOCK_ITEM' },
      ],
      components: [
        { productId: 'dish', componentProductId: 'bun', quantity: '1', wastageRate: '0' },
        // 2 dishes × 0.15 × 1.05 = 0.315 — the 3-dp ledger precision exactly.
        { productId: 'dish', componentProductId: 'patty', quantity: '0.15', wastageRate: '0.05' },
      ],
    });
    await service.depleteSubmittedItems(tx, 't1', 'b1', [ITEM('dish')], 'user-1');

    expect(reduceStock).toHaveBeenCalledWith(tx, { tenantId: 't1', branchId: 'b1' }, [
      { productId: 'bun', productName: 'Bun', quantity: 2, trackInventory: true },
      { productId: 'patty', productName: 'Patty', quantity: 0.315, trackInventory: true },
    ]);
    // The DISH itself never moves — components do.
    expect(movements.map((m) => m.productId)).toEqual(['bun', 'patty']);
  });

  it('a COMPOSED_ITEM with NO recipe depletes NOTHING — the D65 deviation, on purpose', async () => {
    const { service, reduceStock } = buildService();
    const { tx, movements } = buildTx({
      products: [{ id: 'dish', name: 'Kottu', type: 'Inventory', sellableKind: 'COMPOSED_ITEM' }],
    });
    await service.depleteSubmittedItems(tx, 't1', 'b1', [ITEM('dish')], 'user-1');
    expect(reduceStock).not.toHaveBeenCalled();
    expect(movements).toEqual([]);
  });

  it('SERVICE lines and unmigrated (null-product) lines deplete nothing', async () => {
    const { service, reduceStock } = buildService();
    const { tx, movements } = buildTx({
      products: [{ id: 'svc', name: 'Corkage', type: 'Service', sellableKind: 'SERVICE' }],
    });
    await service.depleteSubmittedItems(tx, 't1', 'b1', [ITEM('svc'), ITEM(null)], 'user-1');
    expect(reduceStock).not.toHaveBeenCalled();
    expect(movements).toEqual([]);
  });

  it('a DISABLED-inventory tenant is a full no-op — no queries, no ledger noise', async () => {
    const { service, reduceStock } = buildService(InventoryMode.DISABLED);
    const { tx, raw, movements } = buildTx({
      products: [{ id: 'p1', name: 'X', type: 'Inventory', sellableKind: 'STOCK_ITEM' }],
    });
    await service.depleteSubmittedItems(tx, 't1', 'b1', [ITEM('p1')], 'user-1');
    expect(reduceStock).not.toHaveBeenCalled();
    expect(raw.product.findMany).not.toHaveBeenCalled();
    expect(movements).toEqual([]);
  });
});

describe('RoundDepletionService.restoreVoidedItem', () => {
  const takenMovement = {
    productId: 'bun',
    branchId: 'b1',
    delta: new Prisma.Decimal(-2),
  };

  function txForRestore(alreadyRestored: number) {
    const movements: Record<string, unknown>[] = [];
    const tx = {
      stockMovement: {
        findMany: jest.fn(() => Promise.resolve([takenMovement])),
        count: jest.fn(() => Promise.resolve(alreadyRestored)),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          movements.push(data);
          return Promise.resolve(data);
        }),
      },
      product: {
        findMany: jest.fn(() => Promise.resolve([{ id: 'bun', name: 'Bun' }])),
        findFirst: jest.fn(() =>
          Promise.resolve({ quantityOnHand: new Prisma.Decimal('9') }),
        ),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, movements };
  }

  it('mirrors the RECORDED movements back and marks them VOID', async () => {
    const { service, restoreStock } = buildService();
    const { tx, movements } = txForRestore(0);
    await service.restoreVoidedItem(tx, 't1', 'item-1', 'user-2');

    expect(restoreStock).toHaveBeenCalledWith(tx, { tenantId: 't1', branchId: 'b1' }, [
      { productId: 'bun', productName: 'Bun', quantity: 2, trackInventory: true },
    ]);
    expect(movements).toEqual([
      expect.objectContaining({
        productId: 'bun',
        delta: new Prisma.Decimal(2),
        reason: 'ORDER_ROUND',
        refType: 'RESTAURANT_ORDER_ITEM_VOID',
        refId: 'item-1',
      }),
    ]);
  });

  it('is idempotent: an item already compensated restores nothing again', async () => {
    const { service, restoreStock } = buildService();
    const { tx, movements } = txForRestore(1);
    await service.restoreVoidedItem(tx, 't1', 'item-1', 'user-2');
    expect(restoreStock).not.toHaveBeenCalled();
    expect(movements).toEqual([]);
  });
});
