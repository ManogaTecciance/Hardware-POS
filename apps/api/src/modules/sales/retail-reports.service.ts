import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import { taxRateLabel } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { allocateSaleTax } from './report-tax-allocation';

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
  /**
   * What the shop actually received for these lines, before tax: line net,
   * less the line's proportional share of any order-level discount.
   *
   * The share matters. An order discount is money the shop did not receive,
   * and it belongs to no single line, so leaving it out would overstate every
   * row. This is the same quantity the tax base uses and the same one `8.5`
   * takes its margin from — one definition of "what this line earned",
   * used by every report that needs it.
   */
  revenue: string;
  /** This line's share of the tax its sale charged. See `report-tax-allocation`. */
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

export interface TaxRateRow {
  /** `"18.00"`, or `null` for tax that could not be attributed to a rate. */
  ratePercent: string | null;
  /** `"18%"`, or the reason there is no rate. */
  rateLabel: string;
  /** Net sales charged at this rate, after every discount that reduced the base. */
  taxable: string;
  /** Tax charged at this rate. Rows sum to the tax the sales actually recorded. */
  tax: string;
}

export interface TaxByRateReport {
  from: string;
  to: string;
  rows: TaxRateRow[];
  totals: { taxable: string; tax: string };
  /**
   * True when at least one sale in the range could not be attributed to a rate.
   * The screen says so out loud — a tax figure with a silent hole in it is worse
   * than no figure.
   */
  hasUnattributed: boolean;
}

/** Where a row's unit cost came from. Reported, not inferred by the reader. */
export type CostSource =
  /** `ProductVariant.averageCost` — weighted average across every branch. */
  | 'VARIANT_AVERAGE'
  /** `Product.averageCost`, for a line sold without a variant. */
  | 'PRODUCT_AVERAGE'
  /** `costPrice` — the most recent purchase, used when no average exists. */
  | 'LATEST_PURCHASE'
  /** Nothing has ever been received. Margin is unknown, not zero. */
  | 'UNKNOWN';

export interface MarginRow {
  productId: string | null;
  productName: string;
  productVariantId: string | null;
  variantName: string | null;
  sku: string | null;
  quantitySold: string;
  /** Net of the order discount, as `VariantSalesRow.revenue`. */
  revenue: string;
  /** Quantity × unit cost, or `null` when the cost is unknown. */
  cost: string | null;
  /** Revenue less cost, or `null`. Never 0 as a stand-in for "unknown". */
  margin: string | null;
  /** Margin as a percentage of revenue, 2dp. `null` when either is unknown. */
  marginPercent: string | null;
  costSource: CostSource;
}

export interface MarginReport {
  from: string;
  to: string;
  rows: MarginRow[];
  /**
   * Totals over the rows whose cost IS known. A total that silently treated
   * an unknown cost as zero would report a margin of 100% on it — the most
   * flattering possible lie.
   */
  totals: { revenue: string; cost: string; margin: string; marginPercent: string | null };
  /** Rows excluded from those totals, and what they were worth. */
  unknownCost: { rows: number; revenue: string };
}

/** What a rate row is keyed by when the sale predates per-line rates (3.8). */
const UNATTRIBUTED = 'unattributed';

/** One sale and its lines, in the only shape these reports need. */
type SaleForReport = Prisma.SaleGetPayload<{
  select: {
    subtotal: true;
    totalDiscount: true;
    orderDiscountAmount: true;
    taxAmount: true;
    items: {
      select: {
        productId: true;
        productVariantId: true;
        quantity: true;
        lineTotal: true;
        taxRatePercent: true;
        discountAmount: true;
        promotionDiscountAmount: true;
      };
    };
  };
}>;

/**
 * Phase 8 retail reporting.
 *
 * ## Money never becomes a number here (D108)
 *
 * Every figure is `Prisma.Decimal` from the column to the response, and is
 * emitted with `Decimal.toFixed()`. Nothing is accumulated in JavaScript. That is
 * not stylistic: audit item **A8** is exactly this defect in the restaurant
 * reports, and `report-money.spec.ts` fails the branch if it reappears here.
 *
 * ## Why these load rows instead of using `groupBy`
 *
 * `8.3` originally summed `SaleItem.taxAmount` in SQL, which was fast, elegant
 * and always `0.00`: `sales.service` writes that column as zero on purpose, tax
 * being computed once per sale and parked at line level with grocery (D101).
 * Tax has to be allocated down from `Sale.taxAmount` before it can be grouped by
 * anything, and an allocation is per-sale arithmetic that SQL aggregation cannot
 * express. The rows are therefore loaded and folded in `Decimal`.
 *
 * The cost is real and bounded: one query per report over one date range,
 * selecting seven columns. For the ranges a shop reports on — a day, a week, a
 * month — that is thousands of rows, not millions. A shop large enough to feel
 * it needs a materialised daily rollup, which is a different piece of work.
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
    const sales = await this.load(tenantId, range);

    interface Bucket {
      productId: string | null;
      productVariantId: string | null;
      quantity: Prisma.Decimal;
      revenue: Prisma.Decimal;
      tax: Prisma.Decimal;
      discount: Prisma.Decimal;
    }
    const buckets = new Map<string, Bucket>();

    for (const sale of sales) {
      const allocated = allocateSaleTax(sale.items, sale);
      sale.items.forEach((item, i) => {
        const key = `${item.productId ?? ''}|${item.productVariantId ?? ''}`;
        const bucket =
          buckets.get(key) ??
          {
            productId: item.productId,
            productVariantId: item.productVariantId,
            quantity: ZERO,
            revenue: ZERO,
            tax: ZERO,
            discount: ZERO,
          };
        bucket.quantity = bucket.quantity.plus(item.quantity);
        // `taxable` is line net less its share of the order discount — see
        // `VariantSalesRow.revenue`. The allocator already derived it.
        bucket.revenue = bucket.revenue.plus(allocated[i]!.taxable);
        bucket.tax = bucket.tax.plus(allocated[i]!.tax);
        bucket.discount = bucket.discount
          .plus(item.discountAmount)
          .plus(item.promotionDiscountAmount);
        buckets.set(key, bucket);
      });
    }

    // Names come from the CURRENT product and variant, not the line snapshot.
    // A snapshot is right for a document — it must show what was sold, at the
    // name it was sold under (D44). A report is the opposite: a manager asking
    // "which sizes sold" knows the product by what it is called today, and
    // grouping by snapshot would split one product into two rows after a rename.
    const names = await this.resolveNames(tenantId, [...buckets.values()]);

    const rows: VariantSalesRow[] = [...buckets.values()]
      .map((b) => {
        const named = names.get(`${b.productId ?? ''}|${b.productVariantId ?? ''}`);
        return {
          productId: b.productId,
          productName: named?.productName ?? 'Unknown product',
          productVariantId: b.productVariantId,
          variantName: named?.variantName ?? null,
          sku: named?.sku ?? null,
          quantitySold: b.quantity.toFixed(3),
          revenue: b.revenue.toFixed(2),
          tax: b.tax.toFixed(2),
          discount: b.discount.toFixed(2),
        };
      })
      // Best sellers first, which is the order a buyer reads it in. Ties break
      // on name so the report is stable between runs over the same data.
      .sort(
        (a, b) =>
          new Prisma.Decimal(b.quantitySold).comparedTo(new Prisma.Decimal(a.quantitySold)) ||
          a.productName.localeCompare(b.productName) ||
          (a.variantName ?? '').localeCompare(b.variantName ?? ''),
      );

    const all = [...buckets.values()];
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      rows,
      totals: {
        quantitySold: sum(all.map((b) => b.quantity)).toFixed(3),
        revenue: sum(all.map((b) => b.revenue)).toFixed(2),
        tax: sum(all.map((b) => b.tax)).toFixed(2),
        discount: sum(all.map((b) => b.discount)).toFixed(2),
      },
    };
  }

  /**
   * `8.4` — how much tax was charged at each rate.
   *
   * What a multi-rate shop files its return from, and what a single-rate shop
   * reconciles against its ledger. The allocation rule is the printed document's
   * rule, proven identical to it in `report-tax-allocation.spec.ts`, so a row
   * here and a customer's receipt can never disagree.
   */
  async taxByRate(tenantId: string, range: ReportRange): Promise<TaxByRateReport> {
    const sales = await this.load(tenantId, range);

    const buckets = new Map<string, { rate: Prisma.Decimal | null; taxable: Prisma.Decimal; tax: Prisma.Decimal }>();
    const add = (key: string, rate: Prisma.Decimal | null, taxable: Prisma.Decimal, tax: Prisma.Decimal) => {
      const b = buckets.get(key) ?? { rate, taxable: ZERO, tax: ZERO };
      b.taxable = b.taxable.plus(taxable);
      b.tax = b.tax.plus(tax);
      buckets.set(key, b);
    };

    for (const sale of sales) {
      const allocated = allocateSaleTax(sale.items, sale);
      const unattributed = allocated.some((a) => a.ratePercent === null);

      for (const line of allocated) {
        if (unattributed) {
          // The sale predates per-line rates. Its taxable amounts are known and
          // its tax is real; only the ATTRIBUTION is missing, so both go to a
          // row that says so rather than into the standard rate.
          add(UNATTRIBUTED, null, line.taxable, ZERO);
        } else {
          add(line.ratePercent!.toFixed(2), line.ratePercent, line.taxable, line.tax);
        }
      }
      if (unattributed) {
        // Added once for the sale, not once per line: the tax is a sale-level
        // figure and the allocator refused to divide it.
        add(UNATTRIBUTED, null, ZERO, new Prisma.Decimal(sale.taxAmount));
      }
    }

    const rows: TaxRateRow[] = [...buckets.entries()]
      .map(([key, b]) => ({
        ratePercent: b.rate ? b.rate.toFixed(2) : null,
        rateLabel: b.rate ? taxRateLabel(b.rate.toNumber()) : 'Rate not recorded',
        taxable: b.taxable.toFixed(2),
        tax: b.tax.toFixed(2),
        key,
      }))
      // Highest rate first — the standard rate is what a reader checks — and the
      // unattributed row last, where it reads as a footnote rather than a rate.
      .sort((a, b) => {
        if (a.ratePercent === null) return 1;
        if (b.ratePercent === null) return -1;
        return new Prisma.Decimal(b.ratePercent).comparedTo(new Prisma.Decimal(a.ratePercent));
      })
      .map(({ key: _key, ...row }) => row);

    const all = [...buckets.values()];
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      rows,
      totals: {
        taxable: sum(all.map((b) => b.taxable)).toFixed(2),
        tax: sum(all.map((b) => b.tax)).toFixed(2),
      },
      hasUnattributed: buckets.has(UNATTRIBUTED),
    };
  }

  /**
   * `8.5` — what the goods that sold actually earned.
   *
   * `ProductVariant.averageCost` is maintained by every goods receipt and, until
   * now, read by no report: a shop could see what it sold and never what it
   * made on it.
   *
   * ## The cost is today's, not the day's — stated, not hidden
   *
   * `averageCost` is a MOVING weighted average. A sale from March is costed at
   * the average as it stands now, which is only the same number if nothing has
   * been received since. Costing a historical sale exactly would mean freezing
   * the unit cost onto `SaleItem` at sale time — a schema change, a migration
   * and a decision record, and it could not answer for sales already taken.
   *
   * So this report is an approximation, and D110 records it as one. The screen
   * says so in words rather than printing a figure that looks exact. For a shop
   * whose costs are stable it is very nearly right; for one buying a falling
   * market it flatters recent history, and a reader has to know that.
   *
   * ## An unknown cost is not a zero cost
   *
   * A variant that has never been received has `averageCost = NULL`. Its margin
   * is `null` and it is excluded from the totals, with its revenue reported
   * separately. Treating NULL as 0 would report 100% margin on it, which is the
   * most flattering possible lie and the easiest one to ship by accident.
   */
  async margin(tenantId: string, range: ReportRange): Promise<MarginReport> {
    const sales = await this.load(tenantId, range);

    interface Bucket {
      productId: string | null;
      productVariantId: string | null;
      quantity: Prisma.Decimal;
      revenue: Prisma.Decimal;
    }
    const buckets = new Map<string, Bucket>();
    for (const sale of sales) {
      const allocated = allocateSaleTax(sale.items, sale);
      sale.items.forEach((item, i) => {
        const key = `${item.productId ?? ''}|${item.productVariantId ?? ''}`;
        const bucket =
          buckets.get(key) ??
          {
            productId: item.productId,
            productVariantId: item.productVariantId,
            quantity: ZERO,
            revenue: ZERO,
          };
        bucket.quantity = bucket.quantity.plus(item.quantity);
        bucket.revenue = bucket.revenue.plus(allocated[i]!.taxable);
        buckets.set(key, bucket);
      });
    }

    const info = await this.resolveNames(tenantId, [...buckets.values()]);

    let knownRevenue = ZERO;
    let knownCost = ZERO;
    let unknownRows = 0;
    let unknownRevenue = ZERO;

    const rows: MarginRow[] = [...buckets.values()].map((b) => {
      const named = info.get(`${b.productId ?? ''}|${b.productVariantId ?? ''}`);
      const unitCost = named?.unitCost ?? null;
      const revenue = b.revenue.toDecimalPlaces(2);

      if (unitCost === null) {
        unknownRows += 1;
        unknownRevenue = unknownRevenue.plus(revenue);
        return {
          productId: b.productId,
          productName: named?.productName ?? 'Unknown product',
          productVariantId: b.productVariantId,
          variantName: named?.variantName ?? null,
          sku: named?.sku ?? null,
          quantitySold: b.quantity.toFixed(3),
          revenue: revenue.toFixed(2),
          cost: null,
          margin: null,
          marginPercent: null,
          costSource: 'UNKNOWN' as const,
        };
      }

      // Cost is Decimal(12,4) per unit; the product is rounded to cents once,
      // here, rather than per sale — rounding a unit cost first would lose a
      // fifth of a cent on every unit sold.
      const cost = b.quantity.mul(unitCost).toDecimalPlaces(2);
      const margin = revenue.minus(cost);
      knownRevenue = knownRevenue.plus(revenue);
      knownCost = knownCost.plus(cost);

      return {
        productId: b.productId,
        productName: named?.productName ?? 'Unknown product',
        productVariantId: b.productVariantId,
        variantName: named?.variantName ?? null,
        sku: named?.sku ?? null,
        quantitySold: b.quantity.toFixed(3),
        revenue: revenue.toFixed(2),
        cost: cost.toFixed(2),
        margin: margin.toFixed(2),
        marginPercent: percentOf(margin, revenue),
        costSource: named!.costSource,
      };
    });

    // Thinnest margin first: the row a buyer needs to look at is the one
    // barely earning, not the one earning most. Unknown-cost rows sort last —
    // they are a data problem, not a pricing one.
    rows.sort((a, b) => {
      if (a.margin === null && b.margin === null) return 0;
      if (a.margin === null) return 1;
      if (b.margin === null) return -1;
      return (
        new Prisma.Decimal(a.margin).comparedTo(new Prisma.Decimal(b.margin)) ||
        a.productName.localeCompare(b.productName)
      );
    });

    const totalMargin = knownRevenue.minus(knownCost);
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      rows,
      totals: {
        revenue: knownRevenue.toFixed(2),
        cost: knownCost.toFixed(2),
        margin: totalMargin.toFixed(2),
        marginPercent: percentOf(totalMargin, knownRevenue),
      },
      unknownCost: { rows: unknownRows, revenue: unknownRevenue.toFixed(2) },
    };
  }

  /**
   * Every completed sale in the range, with the columns the reports fold.
   *
   * One query, shared: `8.3` and `8.4` read the same rows for different
   * questions, and both need the sale-level figures the allocation divides.
   */
  private load(tenantId: string, range: ReportRange): Promise<SaleForReport[]> {
    assertRange(range);
    return this.prisma.sale.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        completedAt: { gte: range.from, lte: range.to },
      },
      select: {
        subtotal: true,
        totalDiscount: true,
        orderDiscountAmount: true,
        taxAmount: true,
        items: {
          select: {
            productId: true,
            productVariantId: true,
            quantity: true,
            lineTotal: true,
            taxRatePercent: true,
            discountAmount: true,
            promotionDiscountAmount: true,
          },
        },
      },
    });
  }

  /**
   * Current name, SKU and unit cost for each (product, variant) pair.
   *
   * Cost preference: the variant's weighted average, then the variant's latest
   * purchase, then the same two on the product. Each is a real cost somebody
   * paid; the order runs from the most representative to the least, and the
   * row reports WHICH was used rather than leaving a reader to guess.
   */
  private async resolveNames(
    tenantId: string,
    grouped: { productId: string | null; productVariantId: string | null }[],
  ): Promise<Map<string, ResolvedRow>> {
    const productIds = [...new Set(grouped.map((g) => g.productId).filter(isString))];
    const variantIds = [...new Set(grouped.map((g) => g.productVariantId).filter(isString))];

    const [products, variants] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { tenantId, id: { in: productIds } },
            select: { id: true, name: true, sku: true, averageCost: true, costPrice: true },
          })
        : [],
      variantIds.length
        ? this.prisma.productVariant.findMany({
            where: { tenantId, id: { in: variantIds } },
            select: {
              id: true,
              sku: true,
              averageCost: true,
              costPrice: true,
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

    const out = new Map<string, ResolvedRow>();
    for (const g of grouped) {
      const product = g.productId ? productById.get(g.productId) : undefined;
      const variant = g.productVariantId ? variantById.get(g.productVariantId) : undefined;
      const variantName = variant
        ? [...variant.optionValues]
            .sort((a, b) => a.dimension.position - b.dimension.position)
            .map((ov) => ov.option.name)
            .join(' / ') || null
        : null;
      const cost = costOf(variant ?? null, product ?? null);
      out.set(`${g.productId ?? ''}|${g.productVariantId ?? ''}`, {
        productName: product?.name ?? 'Unknown product',
        variantName,
        sku: variant?.sku ?? product?.sku ?? null,
        unitCost: cost.unitCost,
        costSource: cost.costSource,
      });
    }
    return out;
  }
}

const ZERO = new Prisma.Decimal(0);

interface ResolvedRow {
  productName: string;
  variantName: string | null;
  sku: string | null;
  unitCost: Prisma.Decimal | null;
  costSource: CostSource;
}

type CostBearing = { averageCost: Prisma.Decimal | null; costPrice: Prisma.Decimal | null };

/**
 * The unit cost to charge this line against, and where it came from.
 *
 * **A variant line never falls back to its parent product.** That was the first
 * shape of this function and it is wrong: once `hasVariants` is true the
 * parent's `unitPrice`, `costPrice` and `averageCost` are legacy columns the
 * schema says are not read, and they hold whatever they held before the product
 * gained variants. D44 is the record of exactly that mistake on the PRICE side —
 * the products list showed `Rs 0.00` for every variant product because it read
 * the parent. Reading a stale parent cost would be the same defect, one column
 * over, and it would produce a plausible margin rather than an obvious zero.
 *
 * So: a variant answers for itself, a variant-less line answers from its
 * product, and a thing nothing has ever been received against is `null` —
 * unknown, not free.
 */
function costOf(
  variant: CostBearing | null,
  product: CostBearing | null,
): { unitCost: Prisma.Decimal | null; costSource: CostSource } {
  if (variant) {
    if (variant.averageCost != null) {
      return { unitCost: variant.averageCost, costSource: 'VARIANT_AVERAGE' };
    }
    if (variant.costPrice != null) {
      return { unitCost: variant.costPrice, costSource: 'LATEST_PURCHASE' };
    }
    return { unitCost: null, costSource: 'UNKNOWN' };
  }
  if (product?.averageCost != null) {
    return { unitCost: product.averageCost, costSource: 'PRODUCT_AVERAGE' };
  }
  if (product?.costPrice != null) {
    return { unitCost: product.costPrice, costSource: 'LATEST_PURCHASE' };
  }
  return { unitCost: null, costSource: 'UNKNOWN' };
}

/** `margin / revenue` as a 2dp percentage string, or `null` on a zero base. */
function percentOf(part: Prisma.Decimal, whole: Prisma.Decimal): string | null {
  // A percentage of nothing is not 0%, it is undefined — and a report that
  // prints "0.00%" for a period with no sales has said something false.
  if (whole.isZero()) return null;
  return part.mul(100).div(whole).toDecimalPlaces(2).toFixed(2);
}

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((a, v) => a.plus(v), ZERO);
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
