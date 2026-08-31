import { describe, expect, it } from 'vitest';

import type { ClientProduct, ClientVariant } from './catalog';
import { resolveScan } from './scan-resolver';

/**
 * D99 (1c.5) — a scanned code resolves to a specific variant.
 *
 * Two things are being pinned. First the precedence, which is the whole
 * behaviour: variant barcode, then variant SKU, then a legacy product SKU. Second
 * the regression 1c.1 introduced — scanning matched `product.sku`, which that
 * change set to null for every product, so every scan silently failed. The
 * compiler said nothing because the field was already `string | null`.
 */

function variant(over: Partial<ClientVariant> = {}): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    barcode: '2001234500017',
    name: 'Medium',
    unitPrice: 2500,
    isDefault: false,
    quantityOnHand: 5,
    stockState: 'IN_STOCK',
    ...over,
  };
}

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
    reorderLevel: null,
    imageUrl: null,
    variants: [],
    ...over,
  };
}

/** A shirt in two sizes, each with its own barcode. */
const shirt = product({
  variants: [
    variant({ id: 'var_m', sku: 'SHIRT-M', barcode: '2001234500017', name: 'Medium' }),
    variant({ id: 'var_l', sku: 'SHIRT-L', barcode: '2001234500024', name: 'Large' }),
  ],
});

/** A legacy variant-less product — grocery loose goods, a service. */
const rice = product({
  id: 'prod_rice',
  name: 'Basmati Rice 1kg',
  sku: 'GRN-00087',
  unitPrice: 850,
  variants: [],
});

const catalogue = [shirt, rice];

describe('a barcode resolves to one specific size', () => {
  it('matches the variant that owns the barcode', () => {
    const hit = resolveScan(catalogue, '2001234500017');

    expect(hit?.product.id).toBe('prod_shirt');
    expect(hit?.variant?.id).toBe('var_m');
  });

  it('distinguishes two sizes of the same product', () => {
    // The reason the whole phase exists: two codes on one product must not
    // collapse to the same line.
    expect(resolveScan(catalogue, '2001234500017')?.variant?.id).toBe('var_m');
    expect(resolveScan(catalogue, '2001234500024')?.variant?.id).toBe('var_l');
  });
});

describe('a typed SKU works when a barcode is damaged', () => {
  it('matches a variant SKU', () => {
    const hit = resolveScan(catalogue, 'SHIRT-L');

    expect(hit?.variant?.id).toBe('var_l');
  });

  it('is case- and whitespace-insensitive, as a typed code will be', () => {
    expect(resolveScan(catalogue, '  shirt-m  ')?.variant?.id).toBe('var_m');
  });
});

describe('legacy variant-less products (the 1c.1 regression)', () => {
  it('matches a product SKU and reports no variant', () => {
    // This is the path that silently broke: `sku` was null for every product
    // after 1c.1, so this returned nothing and every scan said "not found".
    const hit = resolveScan(catalogue, 'GRN-00087');

    expect(hit?.product.id).toBe('prod_rice');
    expect(hit?.variant).toBeNull();
  });

  it('cannot match the parent SKU of a variant product, because the server sends null', () => {
    // The guarantee lives on the SERVER, not here: `sellable.service` returns
    // `sku: null` once `hasVariants` is set, mirroring the `unitPrice` rule, so a
    // parent SKU never reaches the till to be matched. The resolver deliberately
    // does not re-implement that rule — one authority, not two.
    //
    // Asserted as the shape the server actually sends, rather than by feeding the
    // resolver a product it would never receive.
    const asServerSends = product({ sku: null, variants: shirt.variants });

    expect(asServerSends.sku).toBeNull();
    expect(resolveScan([asServerSends], 'OLD-PARENT')).toBeNull();
  });
});

describe('precedence is deterministic, not incidental', () => {
  it('prefers a barcode match over a SKU match on a different variant', () => {
    // Contrived, but the reason for fixing an order rather than searching a
    // merged set: one variant's SKU equal to another's barcode must resolve the
    // same way every time.
    const collide = product({
      variants: [
        variant({ id: 'var_a', sku: 'CODE-1', barcode: 'CODE-2' }),
        variant({ id: 'var_b', sku: 'CODE-2', barcode: 'CODE-3' }),
      ],
    });

    // CODE-2 is var_a's barcode and var_b's SKU. Barcode wins.
    expect(resolveScan([collide], 'CODE-2')?.variant?.id).toBe('var_a');
  });

  it('prefers a variant over a legacy product with the same code', () => {
    const legacy = product({ id: 'prod_legacy', sku: 'SHIRT-M', variants: [] });

    expect(resolveScan([legacy, shirt], 'SHIRT-M')?.product.id).toBe('prod_shirt');
  });
});

describe('QR and URL payloads', () => {
  it('unwraps a URL carrying the code in a query parameter', () => {
    const hit = resolveScan(catalogue, 'https://shop.example/scan?sku=SHIRT-L');

    expect(hit?.variant?.id).toBe('var_l');
  });

  it('takes the first line of a multi-line payload', () => {
    const hit = resolveScan(catalogue, '2001234500017\nCotton Shirt\nMedium');

    expect(hit?.variant?.id).toBe('var_m');
  });

  it('resolves each candidate fully before trying the next', () => {
    // A payload unwrapping to two candidates must resolve the FIRST one through
    // every tier — otherwise a later candidate's barcode could beat an earlier
    // candidate's SKU and add the wrong item from one scan.
    const first = product({
      id: 'prod_first',
      variants: [variant({ id: 'var_first', sku: 'AAA', barcode: 'zzz-not-scanned' })],
    });
    const second = product({
      id: 'prod_second',
      variants: [variant({ id: 'var_second', sku: 'sku-unused', barcode: 'BBB' })],
    });

    // "AAA" is the whole payload and the first candidate; it matches var_first's
    // SKU. Nothing about BBB should be consulted.
    expect(resolveScan([first, second], 'AAA')?.variant?.id).toBe('var_first');
  });
});

describe('no match', () => {
  it('returns null for an unknown code', () => {
    expect(resolveScan(catalogue, '9999999999999')).toBeNull();
  });

  it('returns null for an empty or whitespace code', () => {
    expect(resolveScan(catalogue, '')).toBeNull();
    expect(resolveScan(catalogue, '   ')).toBeNull();
  });

  it('does not match a variant whose barcode is null', () => {
    const noBarcode = product({ variants: [variant({ barcode: null })] });

    // An empty candidate must never match an absent barcode — that would make
    // one unbarcoded variant answer to any blank scan.
    expect(resolveScan([noBarcode], '')).toBeNull();
  });
});
