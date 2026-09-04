// The DTO module carries class-validator decorators, which need the metadata
// shim before first evaluation — same as product-variants.contract.spec.ts.
import 'reflect-metadata';

import { Prisma } from '@hardware-pos/database';

import { resolveRoundItemInputs } from './round-item-resolution';
import { RestaurantOrderItemSourceKindDto } from './dto/table-sessions.dto';
import { ProductInactiveError, ProductSoldOutError } from './table-sessions.errors';

/**
 * D101 — the server-side refusal for an 86'd product, at the ONE resolver
 * both intake paths share (dine-in rounds and takeaway, which the counter
 * routes every mode through). POS greying is usability; this is the rule.
 *
 * Paired per D30: the same product without the switch resolves, so the
 * refusal cannot be a resolver that rejects everything.
 */

const TENANT = 'tnt_1';

function productRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'prd_1',
    tenantId: TENANT,
    name: 'Chicken Kottu',
    unitPrice: new Prisma.Decimal(1200),
    isActive: true,
    soldOutAt: null,
    modifierGroups: [],
    ...overrides,
  };
}

function tx(products: unknown[]) {
  return {
    menuItem: { findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => products) },
    productVariant: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    modifierOption: { findMany: jest.fn(async () => []) },
  } as unknown as Prisma.TransactionClient;
}

const input = [
  {
    sourceKind: RestaurantOrderItemSourceKindDto.PRODUCT,
    productId: 'prd_1',
    quantity: 1,
  },
] as never;

describe('resolveRoundItemInputs — sold out (D101)', () => {
  it('refuses an 86\'d product with PRODUCT_SOLD_OUT', async () => {
    const client = tx([productRow({ soldOutAt: new Date('2026-09-03T11:00:00Z') })]);

    await expect(resolveRoundItemInputs(client, TENANT, input)).rejects.toBeInstanceOf(
      ProductSoldOutError,
    );
  });

  it('resolves the same product when the switch is off — the refusal is the flag, not the resolver', async () => {
    const client = tx([productRow()]);

    const resolved = await resolveRoundItemInputs(client, TENANT, input);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.refName).toBe('Chicken Kottu');
  });

  it('inactive still outranks sold-out — config refusal keeps its own name', async () => {
    const client = tx([
      productRow({ isActive: false, soldOutAt: new Date('2026-09-03T11:00:00Z') }),
    ]);

    await expect(resolveRoundItemInputs(client, TENANT, input)).rejects.toBeInstanceOf(
      ProductInactiveError,
    );
  });
});
