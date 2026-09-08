import { productTypeLabel } from '@hardware-pos/shared';
import { describe, expect, it } from 'vitest';

import { stockCap } from './cart';
import { normalizeApi } from './catalog';

/**
 * D136 — how the retail till reads a QuickBooks item off the ONE read model.
 *
 * Two facts that used to be one field. Whether a line has a stock cap is the
 * read model's answer (`stockState`), never the item type; but the badge on
 * the tile still reads the type, because main says "Non-Inventory" there and
 * "Service" is a different thing to a hardware shop. POL-1976 is the regression
 * that pinned the first fact (1ba3900); the second is asserted so the type
 * cannot quietly collapse to two values again.
 */
function api(over: Record<string, unknown> = {}) {
  return {
    id: 'prd_pol_1976',
    name: 'POL-1976',
    sku: 'POL-1976',
    sellableKind: 'STOCK_ITEM',
    unitPrice: '350.00',
    effectivePrice: '350.00',
    category: null,
    subcategory: null,
    imageUrl: null,
    hasVariants: false,
    ...over,
  } as Parameters<typeof normalizeApi>[0];
}

describe('a NonInventory item on the till', () => {
  it('is never capped and is labelled Non-Inventory', () => {
    const p = normalizeApi(api({ type: 'NonInventory', stockState: 'UNTRACKED', availableQuantity: null }));

    expect(p.type).toBe('NonInventory');
    expect(productTypeLabel(p.type)).toBe('Non-Inventory');
    expect(stockCap(p)).toBeNull();
  });

  it('NEGATIVE — an Inventory item at zero is capped at zero, as before', () => {
    const p = normalizeApi(api({ type: 'Inventory', stockState: 'OUT', availableQuantity: '0.000' }));

    expect(p.type).toBe('Inventory');
    expect(stockCap(p)).toBe(0);
  });

  it('a Service item, and an untracked item from a server predating the type, read Service', () => {
    expect(normalizeApi(api({ type: 'Service', stockState: 'UNTRACKED' })).type).toBe('Service');
    expect(normalizeApi(api({ stockState: 'UNTRACKED' })).type).toBe('Service');
  });

  it('the read model, not the type, decides the cap', () => {
    // A tracked item whose type field somehow says NonInventory (a mislabelled
    // import) still caps: the server said it counts, and the server is the one
    // that will refuse the sale.
    const p = normalizeApi(api({ type: 'NonInventory', stockState: 'IN_STOCK', availableQuantity: '4.000' }));
    expect(stockCap(p)).toBe(4);
  });
});
