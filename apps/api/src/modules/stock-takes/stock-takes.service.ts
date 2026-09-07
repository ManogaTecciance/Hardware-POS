import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { ProviderOperationUnavailableError } from '../providers/provider.errors';
import type { StockCountLine } from '../providers/provider.types';
import { CreateStockTakeDto } from './dto/create-stock-take.dto';

export interface StockTakeLineView {
  productId: string;
  productVariantId: string | null;
  productName: string;
  variantName: string | null;
  expectedQuantity: string;
  countedQuantity: string;
  /** `counted - expected`. Negative is shrinkage, positive is a found item. */
  variance: string;
  /** The cost the variance was valued at, or `null` (D110). */
  unitCost: string | null;
  varianceValue: string | null;
}

export interface StockTakeView {
  id: string;
  countNumber: string;
  branchId: string;
  countedAt: string;
  countedByUserId: string;
  countedByName: string | null;
  note: string | null;
  lines: StockTakeLineView[];
  /** Lines whose count differed from the books. */
  varianceLines: number;
  /**
   * Net value of every variance that could be valued. Negative is money missing.
   * `unvaluedLines` says how many variances are NOT in this figure.
   */
  varianceValue: string;
  unvaluedLines: number;
}

/**
 * Stock takes / cycle counts — D111 (`8.7`).
 *
 * ## What a count is
 *
 * An assertion by an operator about what is physically on a shelf. The system
 * records it; it does not argue with it. There is no approval step and no
 * `gte` guard: refusing a count because it disagrees with the books would leave
 * the books wrong AND the shelf uncounted.
 *
 * The stock write itself belongs to the inventory provider
 * (`applyStockCount`) — D28/D31 put that routing decision in one layer, and an
 * architectural tripwire holds the exact file set that may write stock. This
 * service owns the DOCUMENT: numbering, snapshots, valuation and the audit
 * trail.
 *
 * ## Immutable, and honest about what it could not value
 *
 * A posted count is never edited. A recount is another count, which is what a
 * shop actually does.
 *
 * A variance in a variant that has never been received cannot be valued —
 * `unitCost` and `varianceValue` are `null`, not zero, and the response says how
 * many lines that applies to. A shrinkage report that valued unknown stock at
 * zero would say a missing item cost the shop nothing.
 */
@Injectable()
export class StockTakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryProviders: InventoryProviderFactory,
  ) {}

  async create(
    tenantId: string,
    countedByUserId: string,
    dto: CreateStockTakeDto,
  ): Promise<StockTakeView> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
      select: { id: true },
    });
    if (!branch) {
      throw new BadRequestException(`Branch ${dto.branchId} does not belong to this tenant`);
    }

    // The same (product, variant) twice in one count is a form error, not a
    // merge: two different people counted the same shelf and the system cannot
    // know which is right.
    const seen = new Set<string>();
    for (const line of dto.lines) {
      const key = `${line.productId}|${line.productVariantId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException('The same product and variant appears twice in this count');
      }
      seen.add(key);
    }

    if (dto.idempotencyKey) {
      const existing = await this.prisma.stockTake.findFirst({
        where: { tenantId, idempotencyKey: dto.idempotencyKey },
        select: { id: true },
      });
      // Fast path only. The unique index is what actually prevents the double
      // post; this just avoids a wasted transaction on the common resubmit.
      if (existing) return this.getById(tenantId, existing.id);
    }

    const products = await this.resolveNames(tenantId, dto.lines);

    // Resolved OUTSIDE the transaction: the factory reads the business profile
    // and that read must not be holding a write lock.
    const inventory = await this.inventoryProviders.forTenant(tenantId);

    let stockTakeId: string;
    try {
      stockTakeId = await this.prisma.$transaction(async (tx) => {
        const seq = await nextDocumentNumber(tx, tenantId, 'STOCK_TAKE');
        const stockTake = await tx.stockTake.create({
          data: {
            tenantId,
            branchId: dto.branchId,
            countNumber: `SC-${padSequence(seq)}`,
            note: dto.note ?? null,
            countedByUserId,
            idempotencyKey: dto.idempotencyKey ?? null,
          },
        });

        const providerLines: StockCountLine[] = dto.lines.map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId ?? null,
          productName: products.get(key(l.productId, l.productVariantId ?? null))?.productName ?? l.productId,
          countedQuantity: l.countedQuantity,
        }));

        const outcomes = await inventory.applyStockCount(
          tx,
          { tenantId, branchId: dto.branchId },
          providerLines,
          { stockTakeId: stockTake.id, countedByUserId },
        );

        for (const outcome of outcomes) {
          const named = products.get(key(outcome.productId, outcome.productVariantId));
          const variance = new Prisma.Decimal(outcome.variance);
          const unitCost = named?.unitCost ?? null;
          await tx.stockTakeLine.create({
            data: {
              tenantId,
              stockTakeId: stockTake.id,
              productId: outcome.productId,
              productVariantId: outcome.productVariantId,
              // D44 — frozen here, so a later rename cannot rewrite what was
              // counted on the day.
              productNameSnapshot: named?.productName ?? 'Unknown product',
              variantNameSnapshot: named?.variantName ?? null,
              expectedQuantity: new Prisma.Decimal(outcome.expectedQuantity),
              countedQuantity: new Prisma.Decimal(outcome.countedQuantity),
              variance,
              unitCost,
              varianceValue:
                unitCost === null ? null : variance.mul(unitCost).toDecimalPlaces(2),
            },
          });
        }

        return stockTake.id;
      });
    } catch (error) {
      if (error instanceof ProviderOperationUnavailableError) {
        // Reported as a client error, not a 500: nothing is broken. This tenant's
        // stock is owned elsewhere, and the operator needs to be told where.
        throw new BadRequestException(
          'Stock counts are not available for this tenant: stock is not held locally. ' +
            'Correct the quantity in the system that owns it.',
        );
      }
      throw error;
    }

    return this.getById(tenantId, stockTakeId);
  }

  async list(tenantId: string): Promise<StockTakeView[]> {
    const rows = await this.prisma.stockTake.findMany({
      where: { tenantId },
      orderBy: { countedAt: 'desc' },
      take: 100,
      include: { lines: true, countedBy: { select: { name: true } } },
    });
    return rows.map(toView);
  }

  async getById(tenantId: string, id: string): Promise<StockTakeView> {
    const row = await this.prisma.stockTake.findFirst({
      where: { id, tenantId },
      include: { lines: true, countedBy: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException(`Stock take ${id} not found`);
    return toView(row);
  }

  /**
   * Current names and unit costs for the counted lines.
   *
   * Cost preference is D110's, exactly: a variant answers for itself and never
   * reads its parent's legacy cost columns; only a variant-less line reads the
   * product.
   */
  private async resolveNames(
    tenantId: string,
    lines: { productId: string; productVariantId?: string }[],
  ): Promise<Map<string, { productName: string; variantName: string | null; unitCost: Prisma.Decimal | null }>> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const variantIds = [...new Set(lines.map((l) => l.productVariantId).filter(isString))];

    const [products, variants] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: { id: true, name: true, averageCost: true, costPrice: true },
      }),
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

    for (const line of lines) {
      if (!products.some((p) => p.id === line.productId)) {
        throw new BadRequestException(`Product ${line.productId} does not belong to this tenant`);
      }
      if (line.productVariantId && !variants.some((v) => v.id === line.productVariantId)) {
        throw new BadRequestException(
          `Variant ${line.productVariantId} does not belong to this tenant`,
        );
      }
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const out = new Map<
      string,
      { productName: string; variantName: string | null; unitCost: Prisma.Decimal | null }
    >();
    for (const line of lines) {
      const product = productById.get(line.productId);
      const variant = line.productVariantId ? variantById.get(line.productVariantId) : undefined;
      const variantName = variant
        ? [...variant.optionValues]
            .sort((a, b) => a.dimension.position - b.dimension.position)
            .map((ov) => ov.option.name)
            .join(' / ') || variant.sku
        : null;
      const unitCost = variant
        ? (variant.averageCost ?? variant.costPrice ?? null)
        : (product?.averageCost ?? product?.costPrice ?? null);
      out.set(key(line.productId, line.productVariantId ?? null), {
        productName: product?.name ?? 'Unknown product',
        variantName,
        unitCost,
      });
    }
    return out;
  }
}

function key(productId: string, variantId: string | null): string {
  return `${productId}|${variantId ?? ''}`;
}

function isString(v: string | undefined): v is string {
  return typeof v === 'string';
}

type StockTakeRow = Prisma.StockTakeGetPayload<{
  include: { lines: true; countedBy: { select: { name: true } } };
}>;

function toView(row: StockTakeRow): StockTakeView {
  const lines: StockTakeLineView[] = row.lines.map((l) => ({
    productId: l.productId,
    productVariantId: l.productVariantId,
    productName: l.productNameSnapshot,
    variantName: l.variantNameSnapshot,
    expectedQuantity: l.expectedQuantity.toFixed(3),
    countedQuantity: l.countedQuantity.toFixed(3),
    variance: l.variance.toFixed(3),
    unitCost: l.unitCost?.toFixed(4) ?? null,
    varianceValue: l.varianceValue?.toFixed(2) ?? null,
  }));

  const withVariance = row.lines.filter((l) => !l.variance.isZero());
  const valued = withVariance.filter((l) => l.varianceValue !== null);
  const varianceValue = valued.reduce(
    (acc, l) => acc.plus(l.varianceValue!),
    new Prisma.Decimal(0),
  );

  return {
    id: row.id,
    countNumber: row.countNumber,
    branchId: row.branchId,
    countedAt: row.countedAt.toISOString(),
    countedByUserId: row.countedByUserId,
    countedByName: row.countedBy?.name ?? null,
    note: row.note,
    lines,
    varianceLines: withVariance.length,
    varianceValue: varianceValue.toFixed(2),
    unvaluedLines: withVariance.length - valued.length,
  };
}
