import { describe, expect, it } from 'vitest';

import { newCartItem, type CartItem } from './cart';
import type { ClientProduct, ClientVariant } from './catalog';
import { toSaleItemPayload } from './sales';

/**
 * D99 (1c.7) — the till actually sends the variant id.
 *
 * `productVariantId` is optional on the payload AND on the server DTO, so a
 * literal that forgets it compiles, validates, returns 201, and quietly sells at
 * product level — depleting the wrong stock row and freezing no size onto the
 * receipt. The integration spec proves the server handles the id; this is the
 * only thing that proves the client sends it.
 *
 * The same defect shape as the 1c.1 scan regression (`sku: string | null`), the
 * dropped `productVariantId` in `toCartItem`, and the un-passed `stockCap`
 * argument: a type that permits the wrong call.
 */

function product(over: Partial<ClientProduct> = {}): ClientProduct {
  return {
    id: 'prod_shirt',
    name: 'Cotton Shirt',
    sku: null,
    type: 'Inventory',
    categoryName: 'Apparel',
    subcategoryId: null,
    subcategoryName: null,
    unitPrice: null,
    quantityOnHand: 20,
    stockState: 'IN_STOCK',
    imageUrl: null,
    variants: [],
    ...over,
  };
}

function variant(over: Partial<ClientVariant> = {}): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    barcode: null,
    name: 'Black / Medium',
    unitPrice: 2500,
    isDefault: false,
    quantityOnHand: 5,
    stockState: 'IN_STOCK',
    ...over,
  };
}

describe('toSaleItemPayload carries the chosen size', () => {
  it('sends the variant id', () => {
    const item = newCartItem(product(), variant({ id: 'var_m' }));

    expect(toSaleItemPayload(item).productVariantId).toBe('var_m');
  });

  it('sends the size the operator actually chose, not the first one', () => {
    // Guards against a future "just take variants[0]" shortcut.
    const large = variant({ id: 'var_l', name: 'Black / Large' });
    const item = newCartItem(
      product({ variants: [variant({ id: 'var_s' }), large] }),
      large,
    );

    expect(toSaleItemPayload(item).productVariantId).toBe('var_l');
  });

  it('omits the field entirely for a product with no variants', () => {
    // Undefined rather than null: the field is optional on the wire, and every
    // sale in history — loose goods, a service, a single-SKU product — is this
    // shape. Sending an explicit null would be a new value for the server to
    // interpret.
    const item = newCartItem(product({ unitPrice: 1500 }), null);
    const payload = toSaleItemPayload(item);

    expect(payload.productVariantId).toBeUndefined();
    expect(payload.productId).toBe('prod_shirt');
  });
});

describe('the rest of the line survives the extraction', () => {
  it('carries quantity, discount and approval token', () => {
    // The extraction from the page moved seven fields; a silent drop of any one
    // of them loses a discount or an approval, so the whole shape is asserted.
    const item: CartItem = {
      ...newCartItem(product(), variant()),
      quantity: 3,
      discount: { type: 'PERCENTAGE', value: 10, reason: 'Staff' },
      approvalToken: 'tok_123',
    };

    expect(toSaleItemPayload(item)).toEqual({
      productId: 'prod_shirt',
      productVariantId: 'var_m',
      quantity: 3,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      discountReason: 'Staff',
      approvalToken: 'tok_123',
    });
  });

  it('leaves discount fields undefined when the line has no discount', () => {
    const payload = toSaleItemPayload(newCartItem(product(), variant()));

    expect(payload.discountType).toBeUndefined();
    expect(payload.discountValue).toBeUndefined();
    expect(payload.approvalToken).toBeUndefined();
  });
});
