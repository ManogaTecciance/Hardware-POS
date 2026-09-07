import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/** A closed date range, inclusive of both ends in the tenant's local reading. */
export interface ReportRange {
  from: Date;
  to: Date;
}

export interface VariantSalesRow {
  productId: string | null;
  productName: string;
  productVariantId: string | null;
  /** "Medium / Black", or `null` for a product with no variants. */
  variantName: string | null;
  sku: string | null;
  /** 3dp, matching `SaleItem.quantity`. */
  quantitySold: string;
  /** What the customer paid for these lines, after discounts, before tax. */
  revenue: string;
  /** Tax charged on those lines. */
  tax: string;
  /** Line discounts plus allocated promotion, so a buyer can see what was given away. */
  discount: string;
}

export interface VariantSalesReport {
  from: string;
  to: string;
  rows: VariantSalesRow[];
  totals: { quantitySold: string; revenue: string; tax: string; discount: string };
}

/**
 * Phase 8 retail reporting.
 *
 * ## Money never becomes a number here (D108)
 *
 * Every total is summed by Postgres through Prisma's `_sum`, which returns
 * `Prisma.Decimal`, and is emitted with `Decimal.toFixed()`. Nothing is
 * accumulated in JavaScript. That is not stylistic: audit item **A8** is exactly
 * this defect in the restaurant reports, and `report-money.spec.ts` fails the
 * branch if it reappears on the retail side.
 *
 * ## What counts as a sale
 *
 * `status: COMPLETED` and `completedAt` inside the range. A draft is not a sale,
 * and a sale's date is when it was completed rather than when it was started —
 * a basket held overnight (`8.8`) belongs to the day it was paid for.
 *
 * Returns are deliberately NOT netted off. "Which sizes sold this month" is a
 * question about what left the shelf; a manager reconciling refunds asks a
 * different question, and answering both in one column would make neither
 * legible. Returns have their own history.
 */
@Injectable()
export class RetailReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `8.3` — what sold, by product and by size.
   *
   * The first report a clothing buyer asks for: Phase 1 has captured
   * `productVariantId` on every sale line since `1c.7`, and until now nothing
   * read it.
   */
  async salesByVariant(tenantId: string, range: ReportRange): Promise<VariantSalesReport> {
    assertRange(range);

    const grouped = await this.prisma.saleItem.groupBy({
      by: ['productId', 'productVariantId'],
      where: {
        sale: {
          tenantId,
          status: 'COMPLETED',
          completedAt: { gte: range.from, lte: range.to },
        },
      },
      _sum: {
        quantity: true,
        lineTotal: true,
        taxAmount: true,
        discountAmount: true,
        promotionDiscountAmount: true,
      },
    });

    // Names come from the CURRENT product and variant, not the line snapshot.
    // A snapshot is right for a document — it must show what was sold, at the
    // name it was sold under (D44). A report is the opposite: a manager asking
    // "which sizes sold" knows the product by what it is called today, and
    // grouping by snapshot would split one product into two rows after a rename.
    const names = await this.resolveNames(tenantId, grouped);

    const rows: VariantSalesRow[] = grouped
      .map((g) => {
        const key = `${g.productId ?? ''}|${g.productVariantId ?? ''}`;
        const named = names.get(key);
        const discount = dec(g._sum.discountAmount).plus(dec(g._sum.promotionDiscountAmount));
        return {
          productId: g.productId,
          productName: named?.productName ?? 'Unknown product',
          productVariantId: g.productVariantId,
          variantName: named?.variantName ?? null,
          sku: named?.sku ?? null,
          quantitySold: dec(g._sum.quantity).toFixed(3),
          revenue: dec(g._sum.lineTotal).toFixed(2),
          tax: dec(g._sum.taxAmount).toFixed(2),
          discount: discount.toFixed(2),
        };
      })
      // Best sellers first, which is the order a buyer reads it in. Ties break
      // on name so the report is stable between runs over the same data.
      .sort(
        (a, b) =>
          Number(b.quantitySold) - Number(a.quantitySold) ||
          a.productName.localeCompare(b.productName) ||
          (a.variantName ?? '').localeCompare(b.variantName ?? ''),
      );

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      rows,
      totals: {
        quantitySold: sum(grouped.map((g) => dec(g._sum.quantity))).toFixed(3),
        revenue: sum(grouped.map((g) => dec(g._sum.lineTotal))).toFixed(2),
        tax: sum(grouped.map((g) => dec(g._sum.taxAmount))).toFixed(2),
        discount: sum(
          grouped.map((g) =>
            dec(g._sum.discountAmount).plus(dec(g._sum.promotionDiscountAmount)),
          ),
        ).toFixed(2),
      },
    };
  }

  /** Current names for each (product, variant) pair the grouping produced. */
  private async resolveNames(
    tenantId: string,
    grouped: { productId: string | null; productVariantId: string | null }[],
  ): Promise<Map<string, { productName: string; variantName: string | null; sku: string | null }>> {
    const productIds = [...new Set(grouped.map((g) => g.productId).filter(isString))];
    const variantIds = [...new Set(grouped.map((g) => g.productVariantId).filter(isString))];

    const [products, variants] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { tenantId, id: { in: productIds } },
            select: { id: true, name: true, sku: true },
          })
        : [],
      variantIds.length
        ? this.prisma.productVariant.findMany({
            where: { tenantId, id: { in: variantIds } },
            select: {
              id: true,
              sku: true,
              optionValues: {
                select: {
                  option: { select: { name: true } },
                  dimension: { select: { position: true } },
                },
              },
            },
          })
        : [],
    ]);

    const productById = new Map(products.map((p) => [p.id, p]));
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const out = new Map<
      string,
      { productName: string; variantName: string | null; sku: string | null }
    >();
    for (const g of grouped) {
      const product = g.productId ? productById.get(g.productId) : undefined;
      const variant = g.productVariantId ? variantById.get(g.productVariantId) : undefined;
      const variantName = variant
        ? [...variant.optionValues]
            .sort((a, b) => a.dimension.position - b.dimension.position)
            .map((ov) => ov.option.name)
            .join(' / ') || null
        : null;
      out.set(`${g.productId ?? ''}|${g.productVariantId ?? ''}`, {
        productName: product?.name ?? 'Unknown product',
        variantName,
        sku: variant?.sku ?? product?.sku ?? null,
      });
    }
    return out;
  }
}

/** `null` sums to zero — an empty group is 0.00, not a missing figure. */
function dec(value: Prisma.Decimal | null): Prisma.Decimal {
  return value ?? new Prisma.Decimal(0);
}

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((a, v) => a.plus(v), new Prisma.Decimal(0));
}

function isString(v: string | null): v is string {
  return v !== null;
}

function assertRange(range: ReportRange): void {
  if (Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
    throw new BadRequestException('from and to must be valid dates');
  }
  if (range.from > range.to) {
    // Silently swapping them would answer a question nobody asked.
    throw new BadRequestException('from must not be after to');
  }
}
