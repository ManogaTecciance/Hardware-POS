/**
 * PROD-VNT — Product Variants + Purchase Receipts + Weighted-Average (D44).
 *
 * Exercises the D44 backend end-to-end via HTTP: parent product creation,
 * variation declaration, variants:batch, receipt writes, and the downstream
 * inventory / averageCost / purchases views. No UI drive — every other
 * business-critical suite in this repo lives at the API surface so the same
 * tests re-run headless in CI without a browser start.
 *
 * The scenarios follow the "no shared mutation" idiom of the sister files:
 * every product name is minted via `uniq(...)` so a re-run never collides
 * with itself or with seed data, and each test creates its own product from
 * scratch rather than depending on the previous case's fixtures.
 */
import { test, expect } from '../src/fixtures';
import { API_URL, RUN_ID, uniq, type Api } from '../src/api';

/** PUT-variations helper — the `Api` wrapper doesn't expose PUT, so drop to ctx. */
async function putVariations(
  api: Api,
  productId: string,
  dimensions: Array<{
    name: string;
    position: number;
    options: Array<{ name: string; position: number }>;
  }>,
): Promise<{
  dimensions: Array<{
    id: string;
    name: string;
    options: Array<{ id: string; name: string }>;
  }>;
}> {
  const res = await api.ctx.put(`${API_URL}/products/${productId}/variations`, {
    data: { dimensions },
  });
  expect(res.ok(), `PUT /products/${productId}/variations → ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as {
    data: {
      dimensions: Array<{
        id: string;
        name: string;
        options: Array<{ id: string; name: string }>;
      }>;
    };
  };
  return body.data;
}

/** Sum quantityOnHand across every branch a variant inventory response carries. */
function sumInventory(inv: { branches: Array<{ quantityOnHand: number | string }> }): number {
  return inv.branches.reduce((sum, r) => sum + Number(r.quantityOnHand), 0);
}

test.describe('PROD-VNT — Product Variants + Purchase Receipts + Weighted-Average (D44)', () => {
  test('PROD-VNT-001 Coca-Cola: 2 dimensions, 6 variants, 2 receipts, weighted-average cost', async ({
    ownerApi,
  }) => {
    // 1. Parent product — the SKU/price live on the variants, not the parent.
    const parent = await ownerApi.createProduct({
      name: `Coca-Cola ${RUN_ID}`,
      unitPrice: 0,
      quantityOnHand: 0,
    });

    // 2. Declare the two variation dimensions. The server upserts by name and
    //    hands back real ids; the batch endpoint below needs those ids to bind
    //    variants to option values.
    const dims = await putVariations(ownerApi, parent.id, [
      {
        name: 'Size',
        position: 0,
        options: [
          { name: '200ml', position: 0 },
          { name: '300ml', position: 1 },
          { name: '500ml', position: 2 },
          { name: '1000ml', position: 3 },
          { name: '1500ml', position: 4 },
        ],
      },
      {
        name: 'Packaging',
        position: 1,
        options: [
          { name: 'Can', position: 0 },
          { name: 'Glass Bottle', position: 1 },
          { name: 'Plastic Bottle', position: 2 },
        ],
      },
    ]);

    // Sanity check on the returned dimension shape — 2 dimensions, options
    // present, ids present. Without ids the batch below would silently omit
    // every optionValue.
    expect(dims.dimensions).toHaveLength(2);
    const sizeDim = dims.dimensions.find((d) => d.name === 'Size')!;
    const packDim = dims.dimensions.find((d) => d.name === 'Packaging')!;
    expect(sizeDim.options).toHaveLength(5);
    expect(packDim.options).toHaveLength(3);
    for (const opt of [...sizeDim.options, ...packDim.options]) {
      expect(opt.id).toBeTruthy();
    }

    const optId = (dim: typeof sizeDim, name: string): string =>
      dim.options.find((o) => o.name === name)!.id;

    // 3. Batch-create six enabled combinations with SKU + selling price. No
    //    opening quantity here — stock arrives via Receive Stock in steps 6/8.
    //    SKUs suffix RUN_ID so parallel workers never collide on the unique
    //    (tenantId, sku) index.
    const skuOf = (label: string) => `COKE-${label}-${RUN_ID}`;
    const variantsInput = [
      { size: '200ml', pack: 'Glass Bottle', sku: skuOf('200-G'), price: 220 },
      { size: '200ml', pack: 'Plastic Bottle', sku: skuOf('200-P'), price: 200 },
      { size: '300ml', pack: 'Can', sku: skuOf('300-C'), price: 250 },
      { size: '500ml', pack: 'Plastic Bottle', sku: skuOf('500-P'), price: 350 },
      { size: '1000ml', pack: 'Plastic Bottle', sku: skuOf('1L-P'), price: 550 },
      { size: '1500ml', pack: 'Plastic Bottle', sku: skuOf('1_5L-P'), price: 850 },
    ];

    const batch = await ownerApi.post<Array<{ id: string; sku: string }>>(
      `/products/${parent.id}/variants:batch`,
      {
        variants: variantsInput.map((v, position) => ({
          sku: v.sku,
          unitPrice: v.price,
          isActive: true,
          position,
          optionValues: [
            { dimensionId: sizeDim.id, optionId: optId(sizeDim, v.size) },
            { dimensionId: packDim.id, optionId: optId(packDim, v.pack) },
          ],
        })),
      },
    );
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(6);

    // 4. Round-trip the variants list and confirm every SKU landed.
    const listed = await ownerApi.get<Array<{ id: string; sku: string }>>(
      `/products/${parent.id}/variants`,
    );
    expect(listed).toHaveLength(6);
    const skusListed = new Set(listed.map((v) => v.sku));
    for (const v of variantsInput) {
      expect(skusListed.has(v.sku)).toBe(true);
    }

    // 5. Resolve the branch id for this session — receipts must land in a
    //    specific branch, and the owner's authenticated session already carries one.
    const branchId = ownerApi.auth.branch?.id ?? 'brn_dev';
    const targetSku = variantsInput[0]!.sku;
    const target = listed.find((v) => v.sku === targetSku)!;

    // 6. Receipt LOT-1: 100 units at unit cost 150.
    await ownerApi.post('/inventory-receipts', {
      branchId,
      receivedAt: new Date().toISOString(),
      grnReference: `LOT-1-${RUN_ID}`,
      lines: [
        {
          productId: parent.id,
          productVariantId: target.id,
          quantityReceived: 100,
          unitCost: 150,
        },
      ],
    });

    // 7. Inventory after LOT-1 — total across branches is exactly 100.
    const inv1 = await ownerApi.get<{
      branches: Array<{ quantityOnHand: number | string }>;
    }>(`/products/${parent.id}/variants/${target.id}/inventory`);
    expect(sumInventory(inv1)).toBe(100);

    // 8. Receipt LOT-2: 100 units at unit cost 160 (the weighted-average test
    //    — 100@150 + 100@160 should average to exactly 155).
    await ownerApi.post('/inventory-receipts', {
      branchId,
      receivedAt: new Date().toISOString(),
      grnReference: `LOT-2-${RUN_ID}`,
      lines: [
        {
          productId: parent.id,
          productVariantId: target.id,
          quantityReceived: 100,
          unitCost: 160,
        },
      ],
    });

    // 9. Inventory + variant after LOT-2: total 200, averageCost ≈ 155,
    //    costPrice = 160 (latest received cost).
    const inv2 = await ownerApi.get<{
      branches: Array<{ quantityOnHand: number | string }>;
    }>(`/products/${parent.id}/variants/${target.id}/inventory`);
    expect(sumInventory(inv2)).toBe(200);

    const variantsAfter = await ownerApi.get<
      Array<{
        sku: string;
        unitPrice: number | string;
        costPrice: number | string | null;
        averageCost: number | string | null;
      }>
    >(`/products/${parent.id}/variants`);
    const targetAfter = variantsAfter.find((v) => v.sku === targetSku)!;
    // averageCost: (100*150 + 100*160) / 200 = 155. Compared as number so a
    // string decimal from Prisma also passes — the wire type is `string|number`.
    expect(Number(targetAfter.averageCost)).toBeCloseTo(155, 4);
    // costPrice tracks the latest paid unit cost (D44).
    expect(Number(targetAfter.costPrice)).toBe(160);
    // The selling price is untouched by receipts. Weighted-average is a cost
    // fact; whether to raise the price is the operator's call, not the system's.
    expect(Number(targetAfter.unitPrice)).toBe(220);

    // 10. Purchase history for the variant: two lines, most recent first.
    const purchases = await ownerApi.get<Array<{ unitCost: number | string }>>(
      `/products/${parent.id}/variants/${target.id}/purchases`,
    );
    expect(purchases).toHaveLength(2);
    // First row is the LATEST — LOT-2 at unitCost 160 — and second is LOT-1
    // at 150. Ordering by `receivedAt DESC` is the D44 contract for this view.
    expect(Number(purchases[0]!.unitCost)).toBe(160);
    expect(Number(purchases[1]!.unitCost)).toBe(150);
  });

  test('PROD-VNT-002 idempotency: same idempotencyKey returns the same receipt id', async ({
    ownerApi,
  }) => {
    // A minimal single-variant product to receive against — the scenario mirrors
    // PROD-VNT-001 but only needs one variant.
    const parent = await ownerApi.createProduct({
      name: uniq('IdemProd'),
      unitPrice: 0,
      quantityOnHand: 0,
    });
    const dims = await putVariations(ownerApi, parent.id, [
      { name: 'Size', position: 0, options: [{ name: 'One', position: 0 }] },
    ]);
    const dim = dims.dimensions[0]!;
    const [variant] = await ownerApi.post<Array<{ id: string }>>(
      `/products/${parent.id}/variants:batch`,
      {
        variants: [
          {
            sku: `IDEM-${RUN_ID}`,
            unitPrice: 100,
            isActive: true,
            position: 0,
            optionValues: [{ dimensionId: dim.id, optionId: dim.options[0]!.id }],
          },
        ],
      },
    );

    const branchId = ownerApi.auth.branch?.id ?? 'brn_dev';
    const key = `idem-${RUN_ID}`;
    const linePayload = {
      branchId,
      idempotencyKey: key,
      lines: [
        {
          productId: parent.id,
          productVariantId: variant!.id,
          quantityReceived: 5,
          unitCost: 100,
        },
      ],
    };

    // Two POSTs with the same idempotencyKey — the server dedupes on
    // (tenantId, idempotencyKey) and returns the ORIGINAL receipt each time.
    const first = await ownerApi.post<{ id: string }>('/inventory-receipts', linePayload);
    const second = await ownerApi.post<{ id: string }>('/inventory-receipts', linePayload);
    expect(second.id).toBe(first.id);

    // Negative: only one receipt actually committed — a duplicate write would
    // have doubled the variant's on-hand to 10.
    const inv = await ownerApi.get<{
      branches: Array<{ quantityOnHand: number | string }>;
    }>(`/products/${parent.id}/variants/${variant!.id}/inventory`);
    expect(sumInventory(inv)).toBe(5);
  });

  test('PROD-VNT-003 cross-tenant refusal: receiving stock against an unknown product id fails 4xx', async ({
    ownerApi,
  }) => {
    // Fabricated product id — the server never trusts the client's productId
    // blindly. It rejects rather than creating a phantom line.
    const branchId = ownerApi.auth.branch?.id ?? 'brn_dev';
    const res = await ownerApi.postRaw('/inventory-receipts', {
      branchId,
      lines: [
        { productId: 'prod_does_not_exist_xxx', quantityReceived: 1, unitCost: 1 },
      ],
    });
    // 400 (validation), 404 (not-found), or 403 (module/permission) all count
    // as a valid refusal. The point: a bogus id can't quietly commit a receipt.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('PROD-VNT-004 variant deletion refused when history exists (VARIANT_HAS_HISTORY)', async ({
    ownerApi,
  }) => {
    // Two variants: the first stays clean and deletes without conflict; the
    // second gains a receipt, and DELETE against it returns 409.
    const parent = await ownerApi.createProduct({
      name: uniq('DelProd'),
      unitPrice: 0,
      quantityOnHand: 0,
    });
    const dims = await putVariations(ownerApi, parent.id, [
      {
        name: 'Kind',
        position: 0,
        options: [
          { name: 'A', position: 0 },
          { name: 'B', position: 1 },
        ],
      },
    ]);
    const dim = dims.dimensions[0]!;
    const batch = await ownerApi.post<Array<{ id: string }>>(
      `/products/${parent.id}/variants:batch`,
      {
        variants: [
          {
            sku: `DEL-A-${RUN_ID}`,
            unitPrice: 10,
            isActive: true,
            position: 0,
            optionValues: [{ dimensionId: dim.id, optionId: dim.options[0]!.id }],
          },
          {
            sku: `DEL-B-${RUN_ID}`,
            unitPrice: 10,
            isActive: true,
            position: 1,
            optionValues: [{ dimensionId: dim.id, optionId: dim.options[1]!.id }],
          },
        ],
      },
    );

    // First variant has no history — DELETE succeeds (2xx).
    const freshRes = await ownerApi.deleteRaw(
      `/products/${parent.id}/variants/${batch[0]!.id}`,
    );
    expect(freshRes.status()).toBeGreaterThanOrEqual(200);
    expect(freshRes.status()).toBeLessThan(300);

    // Second variant gains a receipt; DELETE now returns 409 + VARIANT_HAS_HISTORY.
    const branchId = ownerApi.auth.branch?.id ?? 'brn_dev';
    await ownerApi.post('/inventory-receipts', {
      branchId,
      lines: [
        {
          productId: parent.id,
          productVariantId: batch[1]!.id,
          quantityReceived: 3,
          unitCost: 5,
        },
      ],
    });
    const conflictRes = await ownerApi.deleteRaw(
      `/products/${parent.id}/variants/${batch[1]!.id}`,
    );
    expect(conflictRes.status()).toBe(409);
    const bodyText = await conflictRes.text();
    // NestJS ConflictException carries a `code` field in the body regardless of
    // envelope shape (top-level or nested inside `data.message`).
    expect(bodyText).toMatch(/VARIANT_HAS_HISTORY/);
  });

  test('PROD-VNT-005 negative quantity and negative unitCost are rejected (400)', async ({
    ownerApi,
  }) => {
    // A pre-existing product isn't strictly required: the DTO validators run
    // before the productId is checked in the service. Creating one just makes
    // the failure attributable to the numeric field rather than a missing FK.
    const parent = await ownerApi.createProduct({
      name: uniq('NegProd'),
      unitPrice: 0,
      quantityOnHand: 0,
    });
    const branchId = ownerApi.auth.branch?.id ?? 'brn_dev';

    const negQty = await ownerApi.postRaw('/inventory-receipts', {
      branchId,
      lines: [{ productId: parent.id, quantityReceived: -1, unitCost: 10 }],
    });
    expect(negQty.status()).toBe(400);

    const negCost = await ownerApi.postRaw('/inventory-receipts', {
      branchId,
      lines: [{ productId: parent.id, quantityReceived: 1, unitCost: -5 }],
    });
    expect(negCost.status()).toBe(400);
  });

  test('PROD-VNT-006 legacy variant-less product still supports create / patch / deactivate', async ({
    ownerApi,
  }) => {
    // The existing factory produces a legacy Inventory product with sku + qty.
    // D44 must not break its lifecycle — the wizard's simple-mode products
    // continue to flow through the same endpoints the pre-D44 UI used.
    const legacy = await ownerApi.createProduct({
      sku: uniq('LEGACY').replace(/\s/g, ''),
      unitPrice: 999,
      quantityOnHand: 3,
    });
    expect(legacy.hasVariants).toBe(false);

    const patched = await ownerApi.patch(`/products/${legacy.id}`, { unitPrice: 1250 });
    expect(Number(patched.unitPrice)).toBe(1250);

    // Deactivate — same path the existing PROD-007 suite uses.
    await ownerApi.patch(`/products/${legacy.id}`, { isActive: false });
    const active = await ownerApi.get<{ items: Array<{ id: string }> }>(
      `/products?page=1&pageSize=200&isActive=true`,
    );
    expect(active.items.find((x) => x.id === legacy.id)).toBeUndefined();
  });
});
