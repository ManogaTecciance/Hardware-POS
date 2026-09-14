/**
 * Kandy Apparel — generated catalogue, do NOT hand-edit.
 *
 * Exported from the `kandy-apparel` workspace by `prisma/export-catalogue.ts`
 * (D170). Pure data with no runtime dependencies, the same contract
 * `mock-catalog.ts` keeps, so the Prisma seed and the API can both import it.
 *
 * Contains no ids or timestamps: a pack is applied by natural key (category
 * name, product SKU, dimension name) precisely so it can be written into a
 * database that has never seen the workspace it came from.
 *
 * To refresh after changing the shop in the app:
 *
 *     pnpm db:export-catalogue -- --slug kandy-apparel --out src/mock-clothing.ts --const CLOTHING_CATALOGUE
 *
 * 16 products · 44 variants · 7 categories
 */
import type { CataloguePack } from './catalogue-pack';

export const CLOTHING_CATALOGUE: CataloguePack = {
  categories: [
    'Clothing',
    'Menswear',
    'Services',
    'Womenswear',
    'Kidswear',
    'Footwear',
    'Accessories',
  ],
  products: [
    {
      name: 'Black Suit',
      type: 'Service',
      description: 'Supiri kit ekak',
      category: 'Menswear',
      unitPrice: 0,
      attributes: {
        fit: 'Regular',
        gender: 'Men',
        season: 'All season',
        material: 'Popcorn',
        careInstructions: 'supiriyak',
      },
      dimensions: [
        {
          name: 'Size',
          options: [
            'L',
            'M',
            'XS',
          ],
        },
        {
          name: 'Color',
          options: [
            'Black',
            'Red',
            'Blue',
          ],
        },
      ],
      variants: [
        {
          sku: 'COL-L-BLA',
          unitPrice: 2000,
          costPrice: 0,
          options: {
            Size: 'L',
            Color: 'Black',
          },
          quantityOnHand: 3,
        },
        {
          sku: 'COL-L-RED',
          unitPrice: 2000,
          costPrice: 0,
          options: {
            Size: 'L',
            Color: 'Red',
          },
          quantityOnHand: 3,
        },
        {
          sku: 'COL-L-BLU',
          unitPrice: 2300,
          costPrice: 0,
          options: {
            Size: 'L',
            Color: 'Blue',
          },
          quantityOnHand: 19,
        },
        {
          sku: 'COL-M-BLA',
          unitPrice: 4000,
          costPrice: 0,
          options: {
            Size: 'M',
            Color: 'Black',
          },
          quantityOnHand: 5,
        },
        {
          sku: 'COL-M-RED',
          unitPrice: 2000,
          costPrice: 0,
          options: {
            Size: 'M',
            Color: 'Red',
          },
          quantityOnHand: 7,
        },
        {
          sku: 'COL-M-BLU',
          unitPrice: 3899,
          costPrice: 0,
          options: {
            Size: 'M',
            Color: 'Blue',
          },
          quantityOnHand: 11,
        },
        {
          sku: 'COL-XS-BLA',
          unitPrice: 1982,
          costPrice: 0,
          options: {
            Size: 'XS',
            Color: 'Black',
          },
          quantityOnHand: 9,
        },
        {
          sku: 'COL-XS-RED',
          unitPrice: 900,
          costPrice: 0,
          options: {
            Size: 'XS',
            Color: 'Red',
          },
          quantityOnHand: 0,
        },
        {
          sku: 'COL-XS-BLU',
          unitPrice: 1299,
          costPrice: 0,
          options: {
            Size: 'XS',
            Color: 'Blue',
          },
          quantityOnHand: 3,
        },
      ],
    },
    {
      name: 'Cotton Crew T-Shirt',
      sku: 'TSH-CRW-03',
      type: 'Inventory',
      description: 'Combed cotton crew neck',
      category: 'Clothing',
      subcategory: 'T-Shirts',
      unitPrice: 2450,
      costPrice: 1150,
      reorderLevel: 24,
      attributes: {
        fit: 'Regular',
        gender: 'Unisex',
        season: 'Summer',
        material: '100% combed cotton',
        careInstructions: 'Machine wash cold, tumble dry low',
      },
      quantityOnHand: 119,
    },
    {
      name: 'Cotton T-Shirt',
      type: 'Inventory',
      category: 'Menswear',
      unitPrice: 0,
      taxable: false,
      dimensions: [
        {
          name: 'Size',
          options: [
            'S',
            'M',
            'L',
            'XL',
          ],
        },
        {
          name: 'Colour',
          options: [
            'Black',
            'White',
            'Navy',
          ],
        },
      ],
      variants: [
        {
          sku: 'TSHIRT-S-BLACK',
          barcode: '2990000000019',
          unitPrice: 1850,
          options: {
            Size: 'S',
            Colour: 'Black',
          },
          quantityOnHand: 9,
        },
        {
          sku: 'TSHIRT-S-WHITE',
          barcode: '2990001000001',
          unitPrice: 1850,
          options: {
            Size: 'S',
            Colour: 'White',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-S-NAVY',
          barcode: '2990000000026',
          unitPrice: 1850,
          options: {
            Size: 'S',
            Colour: 'Navy',
          },
          quantityOnHand: 9,
        },
        {
          sku: 'TSHIRT-M-BLACK',
          barcode: '2990000000033',
          unitPrice: 1850,
          options: {
            Size: 'M',
            Colour: 'Black',
          },
          quantityOnHand: 8,
          isDefault: true,
        },
        {
          sku: 'TSHIRT-M-WHITE',
          barcode: '2990000000040',
          unitPrice: 1850,
          options: {
            Size: 'M',
            Colour: 'White',
          },
          quantityOnHand: 8,
        },
        {
          sku: 'TSHIRT-M-NAVY',
          barcode: '2990000000057',
          unitPrice: 1850,
          options: {
            Size: 'M',
            Colour: 'Navy',
          },
          quantityOnHand: 7,
        },
        {
          sku: 'TSHIRT-L-BLACK',
          barcode: '2990000000064',
          unitPrice: 1850,
          options: {
            Size: 'L',
            Colour: 'Black',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-L-WHITE',
          barcode: '2990000000071',
          unitPrice: 1850,
          options: {
            Size: 'L',
            Colour: 'White',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-L-NAVY',
          barcode: '2990000000088',
          unitPrice: 1850,
          options: {
            Size: 'L',
            Colour: 'Navy',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-XL-BLACK',
          barcode: '2990000000095',
          unitPrice: 1850,
          options: {
            Size: 'XL',
            Colour: 'Black',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-XL-WHITE',
          barcode: '2990000000101',
          unitPrice: 1850,
          options: {
            Size: 'XL',
            Colour: 'White',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'TSHIRT-XL-NAVY',
          barcode: '2990000000118',
          unitPrice: 1850,
          options: {
            Size: 'XL',
            Colour: 'Navy',
          },
          quantityOnHand: 10,
        },
      ],
    },
    {
      name: 'Denim Jeans',
      type: 'Inventory',
      category: 'Menswear',
      unitPrice: 0,
      dimensions: [
        {
          name: 'Size',
          options: [
            '30',
            '32',
            '34',
            '36',
          ],
        },
      ],
      variants: [
        {
          sku: 'JEANS-30',
          barcode: '2990002000000',
          unitPrice: 4500,
          options: {
            Size: '30',
          },
          quantityOnHand: 4,
        },
        {
          sku: 'JEANS-32',
          barcode: '2990000000125',
          unitPrice: 4500,
          options: {
            Size: '32',
          },
          quantityOnHand: 3,
          isDefault: true,
        },
        {
          sku: 'JEANS-34',
          barcode: '2990000000132',
          unitPrice: 4500,
          options: {
            Size: '34',
          },
          quantityOnHand: 5,
        },
        {
          sku: 'JEANS-36',
          barcode: '2990000000149',
          unitPrice: 4500,
          options: {
            Size: '36',
          },
          quantityOnHand: 5,
        },
      ],
    },
    {
      name: 'Fleece Hoodie',
      sku: 'OUT-HDE-06',
      type: 'Inventory',
      description: 'Brushed fleece pullover hoodie',
      category: 'Clothing',
      subcategory: 'Outerwear',
      unitPrice: 9500,
      costPrice: 5200,
      reorderLevel: 4,
      attributes: {
        fit: 'Oversized',
        gender: 'Unisex',
        season: 'Winter',
        material: '80% cotton, 20% polyester',
        careInstructions: 'Wash cold, do not iron print',
      },
      quantityOnHand: 14,
    },
    {
      name: 'Floral Summer Dress',
      sku: 'DRS-FLR-05',
      type: 'Inventory',
      description: 'Knee-length printed rayon dress',
      category: 'Clothing',
      subcategory: 'Dresses',
      unitPrice: 8900,
      costPrice: 4700,
      reorderLevel: 5,
      attributes: {
        fit: 'Regular',
        gender: 'Women',
        season: 'Summer',
        material: '100% rayon',
        careInstructions: 'Gentle cycle, do not tumble dry',
      },
      quantityOnHand: 18,
    },
    {
      name: 'Garment Alteration',
      sku: 'SVC-ALT-10',
      type: 'Service',
      description: 'In-store hemming and taking-in',
      category: 'Services',
      unitPrice: 750,
      quantityOnHand: 0,
    },
    {
      name: 'Kids Polo Shirt',
      sku: 'KID-POL-07',
      type: 'Inventory',
      description: 'Pique polo, ages 4-10',
      category: 'Clothing',
      subcategory: 'Kids',
      unitPrice: 2950,
      costPrice: 1400,
      reorderLevel: 12,
      attributes: {
        fit: 'Regular',
        gender: 'Boys',
        season: 'All season',
        material: '100% cotton pique',
        careInstructions: 'Machine wash warm',
      },
      quantityOnHand: 60,
    },
    {
      name: 'Leather Belt',
      type: 'NonInventory',
      description: 'Full-grain leather belt, 35mm',
      category: 'Accessories',
      subcategory: 'Belts',
      unitPrice: 0,
      attributes: {
        gender: 'Men',
        season: 'All season',
        material: 'Full-grain leather',
        careInstructions: 'Wipe with a dry cloth',
      },
      quantityOnHand: 0,
      dimensions: [
        {
          name: 'Color',
          options: [
            'Black',
            'Brown',
          ],
        },
      ],
    },
    {
      name: 'Linen Trousers',
      sku: 'TRS-LIN-04',
      type: 'Inventory',
      description: 'Breathable linen, drawstring waist',
      category: 'Clothing',
      subcategory: 'Trousers',
      unitPrice: 6400,
      costPrice: 3400,
      reorderLevel: 6,
      attributes: {
        fit: 'Relaxed',
        gender: 'Women',
        season: 'Summer',
        material: '55% linen, 45% viscose',
        careInstructions: 'Hand wash, line dry in shade',
      },
      quantityOnHand: 22,
    },
    {
      name: 'Oxford Shirt',
      sku: 'SHR-OXF-01',
      type: 'Inventory',
      description: 'Long-sleeve cotton Oxford shirt',
      category: 'Clothing',
      subcategory: 'Shirts',
      unitPrice: 4850,
      costPrice: 2600,
      reorderLevel: 10,
      attributes: {
        fit: 'Regular',
        gender: 'Men',
        season: 'All season',
        material: '100% cotton',
        careInstructions: 'Machine wash cold, warm iron',
      },
      quantityOnHand: 48,
    },
    {
      name: 'Saree Blouse (Ready-made)',
      sku: 'ETH-BLS-08',
      type: 'Inventory',
      description: 'Ready-made lined saree blouse',
      category: 'Clothing',
      subcategory: 'Ethnic',
      unitPrice: 3600,
      costPrice: 1800,
      reorderLevel: 10,
      attributes: {
        fit: 'Slim',
        gender: 'Women',
        season: 'All season',
        material: 'Cotton silk blend, lined',
        careInstructions: 'Dry clean recommended',
      },
      quantityOnHand: 40,
    },
    {
      name: 'Shirt',
      type: 'Inventory',
      description: 'White',
      category: 'Menswear',
      unitPrice: 0,
      attributes: {
        fit: 'Slim',
        gender: 'Men',
        season: 'All season',
        material: 'good',
        careInstructions: 'supiriyak',
      },
      dimensions: [
        {
          name: 'Size',
          options: [
            '15 1/2',
            '13 1/2',
          ],
        },
        {
          name: 'Colour',
          options: [
            'White',
            'Black',
          ],
        },
      ],
      variants: [
        {
          sku: 'SHT-15 -WHI',
          unitPrice: 1000,
          costPrice: 0,
          options: {
            Size: '15 1/2',
            Colour: 'White',
          },
          quantityOnHand: 6,
        },
        {
          sku: 'SHT-15 -BLA',
          unitPrice: 1000,
          costPrice: 0,
          options: {
            Size: '15 1/2',
            Colour: 'Black',
          },
          quantityOnHand: 14,
        },
        {
          sku: 'SHT-13 -WHI',
          unitPrice: 1000,
          costPrice: 0,
          options: {
            Size: '13 1/2',
            Colour: 'White',
          },
          quantityOnHand: 19,
        },
      ],
    },
    {
      name: 'Short Pants',
      type: 'Service',
      description: 'Gemmata',
      category: 'Menswear',
      unitPrice: 0,
      attributes: {
        fit: 'Regular',
        gender: 'Men',
        season: 'All season',
        material: 'Cotton',
        careInstructions: 'Test care',
      },
      taxable: false,
      dimensions: [
        {
          name: 'Size',
          options: [
            '32',
            '34',
            '30',
            '36',
          ],
        },
        {
          name: 'Colour',
          options: [
            'Red',
            'Black',
            'Brown',
            'Navy',
          ],
        },
      ],
      variants: [
        {
          sku: 'SHT-32-RED',
          unitPrice: 1580,
          costPrice: 0,
          options: {
            Size: '32',
            Colour: 'Red',
          },
          quantityOnHand: 4,
        },
        {
          sku: 'SHT-32-BLA',
          unitPrice: 2638,
          costPrice: 0,
          options: {
            Size: '32',
            Colour: 'Black',
          },
          quantityOnHand: 5,
        },
        {
          sku: 'SHT-32-BRO',
          unitPrice: 3200,
          costPrice: 0,
          options: {
            Size: '32',
            Colour: 'Brown',
          },
          quantityOnHand: 4,
        },
        {
          sku: 'SHT-32-NAV',
          unitPrice: 4300,
          costPrice: 0,
          options: {
            Size: '32',
            Colour: 'Navy',
          },
          quantityOnHand: 5,
        },
        {
          sku: 'SHT-34-BLA',
          unitPrice: 2100,
          costPrice: 0,
          options: {
            Size: '34',
            Colour: 'Black',
          },
          quantityOnHand: 12,
        },
        {
          sku: 'SHT-34-BRO',
          unitPrice: 1200,
          costPrice: 0,
          options: {
            Size: '34',
            Colour: 'Brown',
          },
          quantityOnHand: 22,
        },
        {
          sku: 'SHT-34-NAV',
          unitPrice: 2300,
          costPrice: 0,
          options: {
            Size: '34',
            Colour: 'Navy',
          },
          quantityOnHand: 22,
        },
        {
          sku: 'SHT-30-BLA',
          unitPrice: 2100,
          costPrice: 0,
          options: {
            Size: '30',
            Colour: 'Black',
          },
          quantityOnHand: 11,
        },
        {
          sku: 'SHT-30-BRO',
          unitPrice: 2100,
          costPrice: 0,
          options: {
            Size: '30',
            Colour: 'Brown',
          },
          quantityOnHand: 10,
        },
        {
          sku: 'SHT-30-NAV',
          unitPrice: 3100,
          costPrice: 0,
          options: {
            Size: '30',
            Colour: 'Navy',
          },
          quantityOnHand: 54,
        },
        {
          sku: 'SHT-36-BLA',
          unitPrice: 2400,
          costPrice: 0,
          options: {
            Size: '36',
            Colour: 'Black',
          },
          quantityOnHand: 12,
        },
        {
          sku: 'SHT-36-BRO',
          unitPrice: 4300,
          costPrice: 0,
          options: {
            Size: '36',
            Colour: 'Brown',
          },
          quantityOnHand: 11,
        },
        {
          sku: 'SHT-36-NAV',
          unitPrice: 2110,
          costPrice: 0,
          options: {
            Size: '36',
            Colour: 'Navy',
          },
          quantityOnHand: 5,
        },
      ],
    },
    {
      name: 'Slim Fit Denim Jeans',
      sku: 'TRS-DNM-02',
      type: 'Inventory',
      description: 'Stretch denim, mid-rise',
      category: 'Clothing',
      subcategory: 'Trousers',
      unitPrice: 7200,
      costPrice: 3900,
      reorderLevel: 8,
      attributes: {
        fit: 'Slim',
        gender: 'Men',
        season: 'All season',
        material: '98% cotton, 2% elastane',
        careInstructions: 'Wash inside out, do not bleach',
      },
      quantityOnHand: 36,
    },
    {
      name: 'Tie',
      type: 'Inventory',
      description: 'GI',
      category: 'Menswear',
      unitPrice: 0,
      attributes: {
        fit: 'Relaxed',
        gender: 'Unisex',
        season: 'All season',
        material: 'Silck',
        careInstructions: 'Dont eat',
      },
      dimensions: [
        {
          name: 'Colour',
          options: [
            'Red',
            'Black',
            'Blue',
          ],
        },
      ],
      variants: [
        {
          sku: 'TIE-RED',
          unitPrice: 500,
          costPrice: 0,
          options: {
            Colour: 'Red',
          },
          quantityOnHand: 6,
        },
        {
          sku: 'TIE-BLA',
          unitPrice: 500,
          costPrice: 0,
          options: {
            Colour: 'Black',
          },
          quantityOnHand: 6,
        },
        {
          sku: 'TIE-BLU',
          unitPrice: 500,
          costPrice: 0,
          options: {
            Colour: 'Blue',
          },
          quantityOnHand: 6,
        },
      ],
    },
  ],
};
