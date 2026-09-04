/**
 * Receive Stock dialog — render coverage (D44).
 *
 * The dialog's job is narrow: gather a well-shaped receipt payload, keep a
 * stable idempotency key across retries, warn about margin-pinching cost
 * jumps, and fire onSuccess+onClose after a save. Each of those contracts is
 * paired with a negative (banner NOT shown for a small delta, key NOT
 * regenerated between retries) per D30.
 *
 * `createReceipt` is mocked at the module boundary so the tests never hit the
 * network; we assert on what the dialog sends, not on any server behaviour.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BranchSummary } from '@/lib/products/branches-api';
import type { InventoryReceipt } from '@/lib/products/receipts-api';
import type { ProductVariant } from '@/lib/products/variants-api';
import type { ManagedProduct } from '@/lib/products-api';
import type { Supplier } from '@/lib/suppliers/types';

// ── Module-boundary mocks ────────────────────────────────────────────────────

const createReceipt = vi.fn<
  (session: unknown, payload: unknown) => Promise<InventoryReceipt>
>();

vi.mock('@/lib/products/receipts-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/receipts-api')>();
  return { ...actual, createReceipt };
});

// Imported after the mock so the dialog module picks it up.
const { ReceiveStockDialog } = await import('./receive-stock-dialog');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const noopSession = { token: 't', user: { tenantId: 'tnt_x' } } as never;

const branches: BranchSummary[] = [
  { id: 'br_main', name: 'Main', code: 'MAIN', address: null, phone: null, registers: [] },
];

const suppliers: Supplier[] = [];

const singleVariantProduct: ManagedProduct = {
  id: 'prod_x',
  name: 'Coca-Cola',
  type: 'Inventory',
  sku: 'COKE',
  description: null,
  categoryId: null,
  subcategoryId: null,
  unitPrice: 220,
  incomeAccount: null,
  purchaseDescription: null,
  costPrice: 150,
  expenseAccount: null,
  quantityOnHand: 0,
  quantityAsOfDate: null,
  reorderLevel: null,
  inventoryAssetAccount: null,
  imageUrl: null,
  isActive: true,
  quickbooksItemId: null,
  syncStatus: 'NOT_SYNCED',
  lastSyncedAt: null,
  hasVariants: false,
  averageCost: null,
  attributes: {},
  sellableKind: 'STOCK_ITEM',
  soldOutAt: null,
  foodType: null,
};

/** One live variant, seeded with a weighted-average so cost-jump assertions bite. */
function variantWithAverage(averageCost: number | null): ProductVariant {
  return {
    id: 'var_1',
    productId: 'prod_x',
    sku: 'COKE-200-G',
    barcode: null,
    unitPrice: 220,
    costPrice: 150,
    averageCost,
    reorderLevel: null,
    imageUrl: null,
    position: 0,
    isActive: true,
    isDefault: false,
    optionValues: [],
  };
}

function fakeReceipt(overrides: Partial<InventoryReceipt> = {}): InventoryReceipt {
  return {
    id: 'rcv_1',
    receiptNumber: 'GRN-0001',
    branchId: 'br_main',
    branchName: 'Main',
    supplierId: null,
    supplierName: null,
    receivedAt: '2026-08-12T00:00:00Z',
    invoiceReference: null,
    grnReference: null,
    notes: null,
    createdByUserId: 'u1',
    createdAt: '2026-08-12T00:00:00Z',
    lines: [
      {
        id: 'ln_1',
        productId: 'prod_x',
        productVariantId: 'var_1',
        quantityReceived: 100,
        unitCost: 160,
        lotNumber: null,
        expiryDate: null,
      },
    ],
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  createReceipt.mockReset();
});

afterEach(cleanup);

/** Fill the three required fields so the submit button becomes enabled. */
function fillRequiredFields(unitCost = '150', quantity = '10'): void {
  fireEvent.change(screen.getByLabelText(/quantity received/i), {
    target: { value: quantity },
  });
  fireEvent.change(screen.getByLabelText(/unit purchase cost/i), {
    target: { value: unitCost },
  });
  // Branch is defaulted from `branches[0]` on open; nothing else needs typing
  // for a single-variant product.
}

// ─────────────────────────────────────────────────────────────────────────────
// Field state + submit gating
// ─────────────────────────────────────────────────────────────────────────────

describe('ReceiveStockDialog — required fields gate the submit button', () => {
  it('mounts with the submit button disabled until qty and unit cost are typed', () => {
    render(
      <ReceiveStockDialog
        open={true}
        onClose={() => {}}
        session={noopSession}
        product={singleVariantProduct}
        variants={[]}
        branches={branches}
        suppliers={suppliers}
        onSuccess={() => {}}
      />,
    );
    const submit = screen.getByRole('button', { name: /receive stock/i }) as HTMLButtonElement;
    // Negative: nothing typed, button disabled.
    expect(submit.disabled).toBe(true);

    fillRequiredFields();

    // Positive: after filling qty + unit cost, the same button is enabled.
    const enabled = screen.getByRole('button', { name: /receive stock/i }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key
// ─────────────────────────────────────────────────────────────────────────────

describe('ReceiveStockDialog — idempotency key is stable across retries', () => {
  it('reuses the same idempotency key on a second submit without reopening', async () => {
    // First call fails so the dialog stays open and the operator can retry.
    createReceipt
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fakeReceipt());

    render(
      <ReceiveStockDialog
        open={true}
        onClose={() => {}}
        session={noopSession}
        product={singleVariantProduct}
        variants={[]}
        branches={branches}
        suppliers={suppliers}
        onSuccess={() => {}}
      />,
    );
    fillRequiredFields();

    // Submit twice against the same open dialog.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /receive stock/i }));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/i));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /receive stock/i }));
    });
    await waitFor(() => expect(createReceipt).toHaveBeenCalledTimes(2));

    const firstKey = (createReceipt.mock.calls[0]![1] as { idempotencyKey: string })
      .idempotencyKey;
    const secondKey = (createReceipt.mock.calls[1]![1] as { idempotencyKey: string })
      .idempotencyKey;

    // Positive: the key exists (crypto.randomUUID present under jsdom) and is
    // reused across the retry — that is what the server needs to dedupe.
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost-change warning banner
// ─────────────────────────────────────────────────────────────────────────────

describe('ReceiveStockDialog — cost-change banner threshold', () => {
  const withVariant = (variant: ProductVariant) =>
    render(
      <ReceiveStockDialog
        open={true}
        onClose={() => {}}
        session={noopSession}
        product={{ ...singleVariantProduct, hasVariants: true }}
        variants={[variant]}
        branches={branches}
        suppliers={suppliers}
        onSuccess={() => {}}
      />,
    );

  it('appears for a > 5% increase over the current weighted average', () => {
    withVariant(variantWithAverage(150));
    fireEvent.change(screen.getByLabelText(/unit purchase cost/i), {
      target: { value: '160' }, // +6.67%
    });
    // Positive: the status-role banner shows with the numeric delta.
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/higher than the current/i);
    expect(status.textContent).toMatch(/7%/); // 6.67% rounds to 7%
  });

  it('does NOT appear when the increase is within the 5% noise floor', () => {
    withVariant(variantWithAverage(150));
    fireEvent.change(screen.getByLabelText(/unit purchase cost/i), {
      target: { value: '155' }, // +3.3% — below threshold
    });
    // Negative: no banner rendered.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does NOT appear when the average cost is unknown', () => {
    withVariant(variantWithAverage(null));
    fireEvent.change(screen.getByLabelText(/unit purchase cost/i), {
      target: { value: '999' },
    });
    // Nothing to compare against — a warning would be a made-up baseline.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does NOT appear on a decrease — cheaper stock is good news, not a warning', () => {
    withVariant(variantWithAverage(150));
    fireEvent.change(screen.getByLabelText(/unit purchase cost/i), {
      target: { value: '140' },
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success flow
// ─────────────────────────────────────────────────────────────────────────────

describe('ReceiveStockDialog — success flow', () => {
  it('calls onSuccess with the receipt, then onClose', async () => {
    const receipt = fakeReceipt();
    createReceipt.mockResolvedValue(receipt);
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <ReceiveStockDialog
        open={true}
        onClose={onClose}
        session={noopSession}
        product={singleVariantProduct}
        variants={[]}
        branches={branches}
        suppliers={suppliers}
        onSuccess={onSuccess}
      />,
    );
    fillRequiredFields();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /receive stock/i }));
    });

    // The dialog delays close by ~350ms so screen-readers can announce the
    // "Stock received" state; advance real time via waitFor.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(receipt));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // Order matters: onSuccess must land BEFORE onClose so the parent can grab
    // the receipt while the dialog is still mounted.
    const successOrder = onSuccess.mock.invocationCallOrder[0]!;
    const closeOrder = onClose.mock.invocationCallOrder[0]!;
    expect(successOrder).toBeLessThan(closeOrder);
  });
});
