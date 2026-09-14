/**
 * Colombo Grocery Mart — generated catalogue, do NOT hand-edit.
 *
 * Exported from the `grocery-demo` workspace by `prisma/export-catalogue.ts`
 * (D191). Pure data with no runtime dependencies, the same contract
 * `mock-catalog.ts` keeps, so the Prisma seed and the API can both import it.
 *
 * Contains no ids or timestamps: a pack is applied by natural key (category
 * name, product SKU, dimension name) precisely so it can be written into a
 * database that has never seen the workspace it came from.
 *
 * To refresh after changing the shop in the app:
 *
 *     pnpm db:export-catalogue -- --slug grocery-demo --out src/mock-grocery.ts --const GROCERY_CATALOGUE
 *
 * 6 products · 9 variants · 6 categories
 */
import type { CataloguePack } from './catalogue-pack';

export const GROCERY_CATALOGUE: CataloguePack = {
  categories: [
    'Beauty Products',
    'Rice & Grains',
    'Sugar, Salt & Spices',
    'Beverages',
    'Fresh Produce',
    'Dairy & Eggs',
  ],
  products: [
    {
      name: 'Baby Soap',
      type: 'Inventory',
      description: 'test soap',
      category: 'Beauty Products',
      unitPrice: 0,
      dimensions: [
        {
          name: 'fragrance',
          options: [
            'Rathmal',
            'Kohoba',
          ],
        },
      ],
      variants: [
        {
          sku: 'SOAP-RAT',
          barcode: '22222209',
          unitPrice: 150,
          costPrice: 0,
          options: {
            fragrance: 'Rathmal',
          },
          quantityOnHand: 18,
        },
        {
          sku: 'SOAP-KOH',
          barcode: '22222208',
          unitPrice: 165,
          costPrice: 0,
          options: {
            fragrance: 'Kohoba',
          },
          quantityOnHand: 20,
        },
      ],
    },
    {
      name: 'Coca-Cola 500ml',
      sku: 'COKE-500',
      type: 'Inventory',
      category: 'Beverages',
      unitPrice: 250,
      reorderLevel: 12,
      quantityOnHand: 48,
    },
    {
      name: 'Coconut Oil',
      type: 'Inventory',
      category: 'Dairy & Eggs',
      unitPrice: 0,
      quantityType: 'DECIMAL',
      unitOfMeasure: 'L',
      dimensions: [
        {
          name: 'Color',
          options: [
            'white',
            'yellow',
          ],
        },
      ],
      variants: [
        {
          sku: 'OIL-WHI',
          unitPrice: 400,
          costPrice: 0,
          options: {
            Color: 'white',
          },
          quantityOnHand: 18,
        },
        {
          sku: 'OIL-YEL',
          unitPrice: 350,
          costPrice: 0,
          options: {
            Color: 'yellow',
          },
          quantityOnHand: 18.5,
        },
      ],
    },
    {
      name: 'Rice',
      type: 'Inventory',
      category: 'Rice & Grains',
      unitPrice: 0,
      quantityType: 'DECIMAL',
      unitOfMeasure: 'kg',
      dimensions: [
        {
          name: 'Variety',
          options: [
            'Samba',
            'Basmathi',
            'Nadu',
          ],
        },
      ],
      variants: [
        {
          sku: 'RICE-SAMBA',
          barcode: '2991000000009',
          unitPrice: 210,
          options: {
            Variety: 'Samba',
          },
          quantityOnHand: 95.625,
          isDefault: true,
        },
        {
          sku: 'RICE-BASMATHI',
          barcode: '2991000000016',
          unitPrice: 480,
          options: {
            Variety: 'Basmathi',
          },
          quantityOnHand: 35,
        },
        {
          sku: 'RICE-NADU',
          barcode: '2991000000023',
          unitPrice: 195,
          options: {
            Variety: 'Nadu',
          },
          quantityOnHand: 57.766,
        },
      ],
    },
    {
      name: 'Sugar (White)',
      sku: 'SUGAR-WHITE',
      type: 'Inventory',
      category: 'Sugar, Salt & Spices',
      unitPrice: 260,
      quantityType: 'DECIMAL',
      unitOfMeasure: 'kg',
      reorderLevel: 5,
      quantityOnHand: 50,
    },
    {
      name: 'Umbalakada',
      type: 'Inventory',
      description: 'test',
      unitPrice: 0,
      quantityType: 'DECIMAL',
      unitOfMeasure: 'kg',
      attributes: {
        material: 'Fish',
        careInstructions: 'supiriyak',
      },
      dimensions: [
        {
          name: 'Size',
          options: [
            'Large',
            'Small',
          ],
        },
      ],
      variants: [
        {
          sku: 'UMB-LAR',
          unitPrice: 3200,
          costPrice: 0,
          options: {
            Size: 'Large',
          },
          quantityOnHand: 20,
        },
        {
          sku: 'UMB-SMA',
          unitPrice: 1200,
          costPrice: 0,
          options: {
            Size: 'Small',
          },
          quantityOnHand: 19.275,
        },
      ],
    },
  ],
};
