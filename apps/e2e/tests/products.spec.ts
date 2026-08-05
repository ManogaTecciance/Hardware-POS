import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';

test.describe('PROD — Products & Categories', () => {
  test('PROD-001 create Inventory product with QB fields', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({
      sku: uniq('SKU').replace(/\s/g, ''),
      unitPrice: 14500,
      costPrice: 9800,
      quantityOnHand: 24,
      reorderLevel: 5,
    });
    expect(p.type).toBe('Inventory');
    expect(Number(p.unitPrice)).toBe(14500);
    const fetched = await ownerApi.get(`/products/${p.id}`);
    expect(fetched.id).toBe(p.id);
  });

  test('PROD-002 create Service product (not stock tracked)', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ type: 'Service', quantityOnHand: 0 });
    expect(p.type).toBe('Service');
  });

  test('PROD-003 create Non-Inventory product', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ type: 'NonInventory', quantityOnHand: 0 });
    expect(p.type).toBe('NonInventory');
  });

  test('PROD-004 name is required (400)', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/products', { type: 'Inventory', unitPrice: 100 });
    expect(res.status()).toBe(400);
  });

  test('PROD-005 negative price rejected (400)', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/products', { name: uniq('Neg'), type: 'Inventory', unitPrice: -5 });
    expect(res.status()).toBe(400);
  });

  test('PROD-006 edit product updates price', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ unitPrice: 1000 });
    const updated = await ownerApi.patch(`/products/${p.id}`, { unitPrice: 1750 });
    expect(Number(updated.unitPrice)).toBe(1750);
  });

  test('PROD-007 deactivate hides from active filter', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct();
    await ownerApi.patch(`/products/${p.id}`, { isActive: false });
    const active = await ownerApi.get(`/products?page=1&pageSize=200&isActive=true`);
    expect(active.items.find((x: any) => x.id === p.id)).toBeUndefined();
  });

  test('PROD-020 duplicate SKU within tenant rejected', async ({ ownerApi }) => {
    const sku = uniq('DUP').replace(/\s/g, '');
    await ownerApi.createProduct({ sku });
    const res = await ownerApi.postRaw('/products', { name: uniq('Dup2'), type: 'Inventory', unitPrice: 100, sku });
    expect([400, 409]).toContain(res.status());
  });

  test('PROD-025 negative reorder point rejected', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/products', {
      name: uniq('BadReorder'), type: 'Inventory', unitPrice: 100, reorderLevel: -1,
    });
    expect(res.status()).toBe(400);
  });

  test('PROD-014 stockStatus=OUT returns only depleted inventory', async ({ ownerApi }) => {
    const out = await ownerApi.createProduct({ quantityOnHand: 0 });
    const page = await ownerApi.get(`/products?page=1&pageSize=200&isActive=true&stockStatus=OUT`);
    const ids = page.items.map((x: any) => x.id);
    expect(ids).toContain(out.id);
    for (const item of page.items) {
      if (item.type === 'Inventory') expect(Number(item.quantityOnHand)).toBeLessThanOrEqual(0);
    }
  });

  test('PROD-022 search by exact SKU', async ({ ownerApi }) => {
    const sku = uniq('FIND').replace(/\s/g, '');
    const p = await ownerApi.createProduct({ sku });
    const res = await ownerApi.get(`/products?page=1&pageSize=20&search=${encodeURIComponent(sku)}`);
    expect(res.items.map((x: any) => x.id)).toContain(p.id);
  });

  test('PROD-008 new product visible beyond first page (paging)', async ({ ownerApi }) => {
    // This used to fetch only page 1 and the LAST page and assert the new product
    // was in one of them. That held while the dev database had under ~400 products
    // and became unreliable the moment it grew past two pages: every run of this
    // suite adds more rows, so a product landing on a middle page was in neither
    // sample. It failed in a full run while passing in isolation — the signature of
    // a test that degrades with accumulated data rather than one that measures
    // pagination. Walking every page tests what the title claims, at any size.
    const p = await ownerApi.createProduct({ name: `ZZZ ${uniq('Last')}` });

    const pageSize = 200;
    const first = await ownerApi.get(`/products?page=1&pageSize=${pageSize}`);
    const totalPages = Math.max(1, Math.ceil(first.total / pageSize));
    // The premise: there really is more than one page, so "beyond the first page"
    // is a meaningful claim rather than a trivially satisfied one.
    expect(totalPages).toBeGreaterThan(1);

    const seen: string[] = first.items.map((x: any) => x.id);
    for (let page = 2; page <= totalPages; page += 1) {
      const next = await ownerApi.get(`/products?page=${page}&pageSize=${pageSize}`);
      seen.push(...next.items.map((x: any) => x.id));
    }

    expect(seen).toContain(p.id);
    // Pagination must not duplicate or drop rows across the walk.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
