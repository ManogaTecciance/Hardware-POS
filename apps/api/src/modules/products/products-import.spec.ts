import * as ExcelJS from 'exceljs';
import type { AttributeField } from '@hardware-pos/shared';

import { ProductsImportService } from './products-import.service';
import type { ProductsService } from './products.service';
import type { ProductAttributesService } from './product-attributes.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CreateProductDto } from './dto/create-product.dto';

/**
 * D168 — the import template carries the tenant's own business details.
 *
 * ## What was reported
 *
 * "template was little bit wrong now after the changes … because we add
 * business details from settings".
 *
 * Correct: D150 made the catalogue's descriptive fields the TENANT's own, and
 * the import template was a fixed list of fourteen QuickBooks columns written
 * long before it. A clothing shop that had configured Material, Fit and Season
 * could set them one product at a time in the wizard and not at all in a sheet
 * of four hundred.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The template is asserted by READING THE WORKBOOK BACK, not by inspecting the
 * array handed to ExcelJS — the defect class here is a column that exists in a
 * variable and never reaches the file.
 *
 * Every "it appears" case is paired with a tenant that configured nothing, run
 * through the same method. A template that appended columns unconditionally
 * would pass the first and fail the second, and that second workspace is
 * hardware, whose sheet must not change at all.
 *
 * The update case is the one that matters most: `{}` and `undefined` look alike
 * in a debugger and are opposite instructions to the API. D64 gives the
 * document replace semantics, so an import that sent `{}` for a row whose
 * business-detail columns were blank would ERASE what the product holds.
 */

const CLOTHING: AttributeField[] = [
  { key: 'material', label: 'Material', type: 'text' },
  { key: 'fit', label: 'Fit', type: 'enum', options: ['Regular', 'Slim'] },
  { key: 'warrantyMonths', label: 'Warranty months', type: 'integer', required: true },
];

type Stub = {
  service: ProductsImportService;
  created: CreateProductDto[];
};

function setup(schema: AttributeField[], existingProduct: { id: string } | null = null): Stub {
  const created: CreateProductDto[] = [];

  const prisma = {
    product: { findFirst: jest.fn().mockResolvedValue(existingProduct) },
  } as unknown as PrismaService;

  const products = {
    create: jest.fn((_t: string, dto: CreateProductDto) => {
      created.push(dto);
      return Promise.resolve({ id: 'prod_new' });
    }),
    update: jest.fn((_t: string, _id: string, dto: CreateProductDto) => {
      created.push(dto);
      return Promise.resolve({ id: 'prod_existing' });
    }),
  } as unknown as ProductsService;

  const attributes = {
    schemaForTenant: jest.fn().mockResolvedValue(schema),
  } as unknown as ProductAttributesService;

  return { service: new ProductsImportService(prisma, products, attributes), created };
}

/** Build a sheet the parser will accept: header row, then the given rows. */
async function sheet(headers: string[], rows: Array<Array<string | number>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Read a generated template back and return its header row. */
async function headersOf(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const out: string[] = [];
  ws.getRow(1).eachCell((cell) => out.push(String(cell.value ?? '')));
  return out;
}

const QB = [
  'Product/service name',
  'Category',
  'Item type',
  'SKU',
  'Sales description',
  'Sales price/rate',
  'Income account',
  'Purchase description',
  'Purchase cost',
  'Expense account',
  'Quantity on hand',
  'Quantity as of date',
  'Reorder point',
  'Inventory asset account',
];

describe('D168 — the template carries the tenant’s business details', () => {
  it('appends one column per configured field, under the tenant’s own label', async () => {
    const { service } = setup(CLOTHING);

    const headers = await headersOf(await service.buildTemplate('t1'));

    // An exact set, in order: the fourteen QuickBooks columns unchanged, then
    // the tenant's three. A reordering or a dropped column fails here.
    expect(headers).toEqual([...QB, 'Material', 'Fit', 'Warranty months']);
  });

  it('a workspace that configured none gets exactly the sheet it always did', async () => {
    /*
     * The isolation half, and the one that protects hardware: its schema is
     * empty, so its template must be byte-for-byte the fourteen columns it has
     * always had.
     */
    const { service } = setup([]);

    expect(await headersOf(await service.buildTemplate('t1'))).toEqual(QB);
  });

  it('reads the columns into attributes, keyed by field key not label', async () => {
    /*
     * The label is what a human types in a spreadsheet; the KEY is what the
     * product stores. Getting this backwards would write `{ Material: … }` and
     * be refused by the validator as an unknown key.
     */
    const { service } = setup(CLOTHING);
    const file = await sheet(
      [...QB, 'Material', 'Fit', 'Warranty months'],
      [['Oxford Shirt', 'Clothing', 'Inventory', 'SH-1', '', 4200, '', '', 2100, '', 10, '', 2, '', 'Cotton', 'Slim', 24]],
    );

    const [row] = await service.preview('t1', { buffer: file });

    expect(row!.errors).toEqual([]);
    expect(row!.attributes).toEqual({ material: 'Cotton', fit: 'Slim', warrantyMonths: 24 });
  });

  it('reports a bad value in the validator’s own words', async () => {
    /*
     * "Slimm" is not one of the field's options. The message comes from
     * `validateAttributes`, the same function the API refuses with, so the
     * sheet's error and the endpoint's error cannot drift apart.
     */
    const { service } = setup(CLOTHING);
    const file = await sheet(
      [...QB, 'Material', 'Fit', 'Warranty months'],
      [['Oxford Shirt', 'Clothing', 'Inventory', 'SH-1', '', 4200, '', '', 2100, '', 10, '', 2, '', 'Cotton', 'Slimm', 24]],
    );

    const [row] = await service.preview('t1', { buffer: file });

    expect(row!.errors.join(' ')).toMatch(/Fit/i);
    expect(row!.errors.length).toBeGreaterThan(0);
  });

  it('a CREATE missing a required field is caught at preview, not at commit', async () => {
    // The operator finds out while reviewing four hundred rows, not when the
    // twelfth one fails halfway through the import.
    const { service } = setup(CLOTHING);
    const file = await sheet(
      [...QB, 'Material', 'Fit', 'Warranty months'],
      [['Oxford Shirt', 'Clothing', 'Inventory', 'SH-1', '', 4200, '', '', 2100, '', 10, '', 2, '', 'Cotton', 'Slim', '']],
    );

    const [row] = await service.preview('t1', { buffer: file });

    expect(row!.errors.join(' ')).toMatch(/warranty/i);
  });

  it('an UPDATE whose columns are blank sends NOTHING, so stored details survive', async () => {
    /*
     * The failure this guard exists for. D64 gives the attributes document
     * replace semantics: `{}` is "the product has no business details", which
     * on an update ERASES them. A sheet that simply does not fill these columns
     * must leave the product alone, so the row carries `undefined`.
     */
    const { service } = setup(CLOTHING, { id: 'prod_existing' });
    const file = await sheet(
      [...QB, 'Material', 'Fit', 'Warranty months'],
      [['Oxford Shirt', 'Clothing', 'Inventory', 'SH-1', '', 4200, '', '', 2100, '', 10, '', 2, '', '', '', '']],
    );

    const [row] = await service.preview('t1', { buffer: file });

    expect(row!.matchStatus).toBe('update');
    expect(row!.attributes).toBeUndefined();
    // …and no required-field error, because nothing is being written.
    expect(row!.errors).toEqual([]);
  });

  it('carries the attributes through commit onto the product', async () => {
    /*
     * The end of the chain. Everything above could pass while `commit` dropped
     * the field on the floor — which is exactly what it did before D168.
     */
    const { service, created } = setup(CLOTHING);

    await service.commit('t1', 'OWNER' as never, [
      {
        rowNumber: 2,
        name: 'Oxford Shirt',
        type: 'Inventory',
        sku: 'SH-1',
        unitPrice: 4200,
        attributes: { material: 'Cotton', fit: 'Slim', warrantyMonths: 24 },
      } as never,
    ]);

    expect(created[0]!.attributes).toEqual({ material: 'Cotton', fit: 'Slim', warrantyMonths: 24 });
  });

  it('omits attributes entirely when the row carries none', async () => {
    // The other side of the same coin, at the layer that actually writes.
    const { service, created } = setup(CLOTHING);

    await service.commit('t1', 'OWNER' as never, [
      { rowNumber: 2, name: 'Oxford Shirt', type: 'Inventory', sku: 'SH-1', unitPrice: 4200 } as never,
    ]);

    expect(created[0]).not.toHaveProperty('attributes');
  });
});
