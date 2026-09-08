import { describe, expect, it } from 'vitest';

import { newCartItem, type CartItem } from './cart';
import type { ClientProduct, ClientVariant } from './catalog';
import { toDraftLinePayload } from './held-sales';
import { toSaleItemPayload } from './sales';

/**
 * D136 — a held basket rings up as it was held.
 *
 * The hold button used to build its lines from its own field list, which is
 * how `discountBasis` went missing from it while the sale's mapper carried
 * it: a "100 off each unit" agreed before the fitting room came back as
 * "100 off the line". One mapper, plus the note, and the two cannot diverge.
 */
function product(): ClientProduct {
  return {
    id: 'prod_shirt',
    name: 'Cotton Shirt',
    sku: null,
    type: 'Inventory',
    categoryName: 'Apparel',
    subcategoryId: null,
    subcategoryName: null,
    unitPrice: null,
    quantityOnHand: 0,
    stockState: 'IN_STOCK',
    taxable: true,
    quantityType: 'WHOLE',
    unitOfMeasure: null,
    imageUrl: null,
    variants: [],
  };
}

function variant(): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    barcode: null,
    name: 'M',
    unitPrice: 1000,
    isDefault: false,
    quantityOnHand: 5,
    stockState: 'IN_STOCK',
  };
}

describe('toDraftLinePayload', () => {
  it('is the sale line plus the note — basis included', () => {
    const item: CartItem = {
      ...newCartItem(product(), variant()),
      quantity: 3,
      discount: { type: 'FIXED', value: 100, basis: 'UNIT', reason: 'Agreed' },
      approvalToken: 'tok_1',
      note: 'Fitting room',
    };

    expect(toDraftLinePayload(item)).toEqual({ ...toSaleItemPayload(item), note: 'Fitting room' });
    expect(toDraftLinePayload(item).discountBasis).toBe('UNIT');
    expect(toDraftLinePayload(item).productVariantId).toBe('var_m');
  });

  it('NEGATIVE — a line with no note and no discount sends neither', () => {
    const payload = toDraftLinePayload(newCartItem(product(), variant()));
    expect(payload.note).toBeUndefined();
    expect(payload.discountBasis).toBeUndefined();
    expect(payload.discountType).toBeUndefined();
  });
});
