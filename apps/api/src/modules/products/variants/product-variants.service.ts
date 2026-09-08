import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMode, Prisma } from '@hardware-pos/database';

import { nextDocumentNumber, padSequence } from '../../../common/document-sequence';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../common/storage/storage.service';
import { BusinessProfileService } from '../../platform/business-profile.service';
import { InventoryProviderFactory } from '../../providers/inventory/inventory-provider.factory';
import { ProductVariantsRepository } from './product-variants.repository';
import {
  CreateVariantBatchDto,
  CreateVariantInputDto,
} from './dto/create-variant-batch.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { ReplaceVariationsDto } from './dto/variation-dimensions.dto';

/** JSON-friendly shape for a variant's option snapshot. */
export interface VariantOptionValueView {
  dimensionId: string;
  optionId: string;
  dimensionName: string;
  optionName: string;
}

/** JSON-friendly shape for a variant row (list + read). */
export interface VariantView {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  unitPrice: string;
  costPrice: string | null;
  averageCost: string | null;
  reorderLevel: string | null;
  imageUrl: string | null;
  position: number;
  isActive: boolean;
  /**
   * D46 — one variant per product may be marked default; the POS
   * Customise dialog preselects it. NULL-safe: `false` for every legacy
   * row, `true` for at most one row per product (partial unique index).
   */
  isDefault: boolean;
  optionValues: VariantOptionValueView[];
}

/** JSON-friendly shape for a variation dimension (with its options). */
export interface VariationDimensionView {
  id: string;
  name: string;
  position: number;
  options: { id: string; name: string; position: number }[];
}

/** JSON-friendly shape for a per-branch inventory row. */
export interface VariantBranchInventoryView {
  branchId: string;
  branchName: string;
  quantityOnHand: string;
  averageCost: string | null;
  reorderLevel: string | null;
}

/** JSON-friendly shape for a purchase-history row. */
export interface VariantPurchaseView {
  receiptId: string;
  receiptNumber: string;
  receivedAt: Date;
  supplierId: string | null;
  supplierName: string | null;
  invoiceReference: string | null;
  grnReference: string | null;
  lotNumber: string | null;
  expiryDate: Date | null;
  quantityReceived: string;
  unitCost: string;
}

/**
 * Product-variant orchestration.
 *
 * Holds `InventoryProviderFactory` deliberately: the batch-create-with-opening-
 * stock path routes through the same `receiveStock` pipeline as a future GRN so
 * weighted-average cost is seeded on ONE code path (D44). Every other endpoint
 * is provider-neutral and stays inside the products module.
 */
@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly repo: ProductVariantsRepository,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly businessProfile: BusinessProfileService,
    private readonly inventoryProviders: InventoryProviderFactory,
  ) {}

  // ── Variations (dimensions + options) ──────────────────────────────────────

  async listVariations(tenantId: string, productId: string): Promise<{
    dimensions: VariationDimensionView[];
  }> {
    await this.assertProduct(tenantId, productId);
    const dims = await this.repo.listDimensions(productId);
    return {
      dimensions: dims.map((d) => ({
        id: d.id,
        name: d.name,
        position: d.position,
        options: d.options.map((o) => ({ id: o.id, name: o.name, position: o.position })),
      })),
    };
  }

  /**
   * Structural upsert: the request declares the target shape and the service
   * converges to it. Matching is by `name` (within its parent) so a rename is
   * modelled as delete + create — and the delete refuses to run when any
   * variant is bound to it, which is how a wizard cannot silently orphan a
   * variant's option snapshot.
   */
  async replaceVariations(
    tenantId: string,
    productId: string,
    dto: ReplaceVariationsDto,
  ): Promise<{ dimensions: VariationDimensionView[] }> {
    await this.assertProduct(tenantId, productId);

    // Empty-name / empty-option guards live in DTO decorators; the service is
    // free to trust the shape.
    const requestedDimensionNames = new Set(dto.dimensions.map((d) => d.name));

    await this.prisma.$transaction(async (tx) => {
      const existingDims = await tx.productVariationDimension.findMany({
        where: { productId },
        include: { options: true },
      });

      // 1. Prune dimensions that disappear from the payload — but only when no
      //    variant is bound to them. `_count.variantValues` reports zero in the
      //    happy path and > 0 exactly when the wizard is trying to rewrite a
      //    dimension that is already referenced by a live variant.
      for (const existing of existingDims) {
        if (requestedDimensionNames.has(existing.name)) continue;
        const inUse = await tx.productVariantOptionValue.count({
          where: { dimensionId: existing.id },
        });
        if (inUse > 0) {
          throw new ConflictException({
            code: 'DIMENSION_IN_USE',
            message: `Dimension "${existing.name}" is referenced by ${inUse} variant(s) and cannot be removed`,
          });
        }
        await tx.productVariationDimension.delete({ where: { id: existing.id } });
      }

      // 2. Upsert dimensions and their options in-order.
      for (const [dIndex, dimReq] of dto.dimensions.entries()) {
        const dimension = await tx.productVariationDimension.upsert({
          where: { productId_name: { productId, name: dimReq.name } },
          create: {
            tenantId,
            productId,
            name: dimReq.name,
            position: dimReq.position ?? dIndex,
          },
          update: { position: dimReq.position ?? dIndex },
          include: { options: true },
        });

        const requestedOptionNames = new Set(dimReq.options.map((o) => o.name));
        for (const existingOpt of dimension.options) {
          if (requestedOptionNames.has(existingOpt.name)) continue;
          const inUse = await tx.productVariantOptionValue.count({
            where: { optionId: existingOpt.id },
          });
          if (inUse > 0) {
            throw new ConflictException({
              code: 'OPTION_IN_USE',
              message: `Option "${existingOpt.name}" on dimension "${dimension.name}" is referenced by ${inUse} variant(s) and cannot be removed`,
            });
          }
          await tx.productVariationOption.delete({ where: { id: existingOpt.id } });
        }

        for (const [oIndex, optReq] of dimReq.options.entries()) {
          await tx.productVariationOption.upsert({
            where: {
              dimensionId_name: { dimensionId: dimension.id, name: optReq.name },
            },
            create: {
              tenantId,
              dimensionId: dimension.id,
              name: optReq.name,
              position: optReq.position ?? oIndex,
            },
            update: { position: optReq.position ?? oIndex },
          });
        }
      }
    });

    return this.listVariations(tenantId, productId);
  }

  // ── Variants ───────────────────────────────────────────────────────────────

  async listVariants(tenantId: string, productId: string): Promise<VariantView[]> {
    await this.assertProduct(tenantId, productId);
    const rows = await this.repo.listVariants(productId);
    return rows.map(toVariantView);
  }

  /**
   * Batch-create every enabled variant for a product, plus seed opening stock
   * on the shared receipt pipeline. All in ONE transaction so a partial commit
   * cannot leave a product half-configured.
   */
  async createVariantsBatch(
    tenantId: string,
    productId: string,
    createdByUserId: string,
    dto: CreateVariantBatchDto,
  ): Promise<VariantView[]> {
    const product = await this.assertProduct(tenantId, productId);

    const openingLines = dto.variants.filter((v) => (v.openingQuantity ?? 0) > 0);
    if (openingLines.length > 0) {
      const profile = await this.businessProfile.getEffectiveProfile(tenantId);
      if (profile.inventoryMode !== InventoryMode.LOCAL) {
        throw new BadRequestException(
          'Opening quantity is only supported for LOCAL inventory tenants; use QuickBooks or receive stock after creation.',
        );
      }
      if (!dto.openingBranchId) {
        throw new BadRequestException(
          'openingBranchId is required when any variant carries an openingQuantity > 0',
        );
      }
      const branch = await this.prisma.branch.findFirst({
        where: { id: dto.openingBranchId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!branch) {
        throw new BadRequestException(
          `Branch ${dto.openingBranchId} does not belong to this tenant or is inactive`,
        );
      }
    }

    // Cross-check every referenced (dimension, option) belongs to this product.
    const dimensions = await this.repo.listDimensions(productId);
    const validOptionByDimension = new Map<string, Set<string>>();
    for (const d of dimensions) {
      validOptionByDimension.set(d.id, new Set(d.options.map((o) => o.id)));
    }
    for (const v of dto.variants) {
      // Every dimension must be covered exactly once — otherwise the variant's
      // identity is under-specified and future sales cannot map back to it.
      const seen = new Set<string>();
      for (const ov of v.optionValues) {
        if (seen.has(ov.dimensionId)) {
          throw new BadRequestException(
            `Variant ${v.sku} lists dimension ${ov.dimensionId} twice`,
          );
        }
        seen.add(ov.dimensionId);
        const options = validOptionByDimension.get(ov.dimensionId);
        if (!options) {
          throw new BadRequestException(
            `Variant ${v.sku} references unknown dimension ${ov.dimensionId} for product ${productId}`,
          );
        }
        if (!options.has(ov.optionId)) {
          throw new BadRequestException(
            `Variant ${v.sku} references option ${ov.optionId} that does not belong to dimension ${ov.dimensionId}`,
          );
        }
      }
      if (dimensions.length > 0 && seen.size !== dimensions.length) {
        throw new BadRequestException(
          `Variant ${v.sku} must specify one option per dimension (${dimensions.length} expected, got ${seen.size})`,
        );
      }
    }

    const inventory = openingLines.length > 0
      ? await this.inventoryProviders.forTenant(tenantId)
      : null;

    const createdIds = await this.prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      const openingReceiptInputs: {
        variantId: string;
        variant: CreateVariantInputDto;
      }[] = [];

      for (const [index, v] of dto.variants.entries()) {
        try {
          const created = await tx.productVariant.create({
            data: {
              tenantId,
              productId,
              sku: v.sku,
              barcode: v.barcode ?? null,
              unitPrice: v.unitPrice,
              costPrice: v.costPrice ?? null,
              reorderLevel: v.reorderLevel ?? null,
              imageUrl: v.imageUrl ?? null,
              position: v.position ?? index,
              isActive: v.isActive ?? true,
              // D46 — one variant per product may be marked default; the
              // partial unique index refuses a second one at the DB layer.
              isDefault: v.isDefault ?? false,
            },
          });
          ids.push(created.id);

          for (const ov of v.optionValues) {
            await tx.productVariantOptionValue.create({
              data: {
                tenantId,
                variantId: created.id,
                dimensionId: ov.dimensionId,
                optionId: ov.optionId,
              },
            });
          }

          if ((v.openingQuantity ?? 0) > 0) {
            openingReceiptInputs.push({ variantId: created.id, variant: v });
          }
        } catch (err) {
          throw mapWriteError(err);
        }
      }

      if (!product.hasVariants) {
        await tx.product.update({
          where: { id: productId },
          data: { hasVariants: true },
        });
      }

      // Route opening stock through the same InventoryProvider.receiveStock as
      // a real GRN — the whole point of D44 is that opening stock is not a
      // second, parallel weighted-average path.
      if (openingReceiptInputs.length > 0 && inventory && dto.openingBranchId) {
        const seq = await nextDocumentNumber(tx, tenantId, 'RECEIPT');
        const receipt = await tx.inventoryReceipt.create({
          data: {
            tenantId,
            branchId: dto.openingBranchId,
            supplierId: null,
            receiptNumber: `RCV-${padSequence(seq)}`,
            notes: 'Opening stock — created with product',
            createdByUserId,
          },
        });

        const lines = [] as {
          productId: string;
          productVariantId: string | null;
          productName: string;
          variantSku: string | null;
          quantity: number;
          unitCost: number;
          receiptLineId: string;
        }[];

        for (const { variantId, variant } of openingReceiptInputs) {
          const line = await tx.inventoryReceiptLine.create({
            data: {
              tenantId,
              receiptId: receipt.id,
              productId,
              productVariantId: variantId,
              quantityReceived: variant.openingQuantity!,
              // costPrice absent → unitCost 0. The service surface (§spec) does
              // not require costPrice for opening stock; a zero-cost opening
              // receipt is a legitimate initial condition and the operator can
              // correct it with a subsequent adjustment or receipt.
              unitCost: variant.costPrice ?? 0,
            },
          });
          lines.push({
            productId,
            productVariantId: variantId,
            productName: variant.sku,
            variantSku: variant.sku,
            quantity: Number(variant.openingQuantity),
            unitCost: Number(variant.costPrice ?? 0),
            receiptLineId: line.id,
          });
        }

        const outcomes = await inventory.receiveStock(
          tx,
          { tenantId, branchId: dto.openingBranchId },
          lines,
          { receiptId: receipt.id, createdByUserId },
        );

        // Refresh variant.averageCost + costPrice mirror from the outcomes.
        for (const outcome of outcomes) {
          if (!outcome.productVariantId) continue;
          await tx.productVariant.update({
            where: { id: outcome.productVariantId },
            data: {
              averageCost: outcome.averageCostAfter,
              costPrice: outcome.averageCostAfter,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            userId: createdByUserId,
            action: 'INVENTORY_RECEIVED',
            entityType: 'InventoryReceipt',
            entityId: receipt.id,
            metadata: {
              receiptNumber: receipt.receiptNumber,
              opening: true,
              lineCount: lines.length,
              totalQty: lines.reduce((s, l) => s + l.quantity, 0),
            } as Prisma.InputJsonValue,
          },
        });
      }

      return ids;
    });

    // Re-read after the transaction — the wizard needs the enriched view
    // (option names, refreshed averageCost) not a Prisma echo of the writes.
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: createdIds } },
      include: {
        optionValues: {
          include: {
            dimension: { select: { id: true, name: true } },
            option: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ position: 'asc' }, { sku: 'asc' }],
    });
    return rows.map(toVariantView);
  }

  async updateVariant(
    tenantId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<VariantView> {
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);

    try {
      // D46 — setting `isDefault=true` requires flipping any prior
      // default on the same product to false first, since the partial
      // unique index (`ProductVariant_productId_default_key`) refuses
      // a second default row on the same product. One transaction so
      // the DB never observes two defaults simultaneously.
      if (dto.isDefault === true) {
        await this.prisma.$transaction(async (tx) => {
          await tx.productVariant.updateMany({
            where: { productId, tenantId, isDefault: true, NOT: { id: variantId } },
            data: { isDefault: false },
          });
          await tx.productVariant.update({
            where: { id: variantId },
            data: {
              sku: dto.sku,
              barcode: dto.barcode,
              unitPrice: dto.unitPrice,
              costPrice: dto.costPrice,
              reorderLevel: dto.reorderLevel,
              imageUrl: dto.imageUrl,
              position: dto.position,
              isActive: dto.isActive,
              isDefault: true,
            },
          });
        });
      } else {
        await this.repo.updateVariant(variantId, {
          sku: dto.sku,
          barcode: dto.barcode,
          unitPrice: dto.unitPrice,
          costPrice: dto.costPrice,
          reorderLevel: dto.reorderLevel,
          imageUrl: dto.imageUrl,
          position: dto.position,
          isActive: dto.isActive,
          // Only touch isDefault when the client sent a value — an
          // omitted field is "no change", NOT "clear the default".
          ...(dto.isDefault === false ? { isDefault: false } : {}),
        });
      }
    } catch (err) {
      throw mapWriteError(err);
    }

    const fresh = await this.repo.findVariant(tenantId, productId, variantId);
    return toVariantView(fresh!);
  }

  async deleteVariant(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<{ id: string }> {
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);

    if (await this.repo.variantHasHistory(variantId)) {
      throw new ConflictException({
        code: 'VARIANT_HAS_HISTORY',
        message:
          'This variant has sale, return, menu, receipt or stock-movement history and cannot be deleted. Mark it inactive instead.',
      });
    }

    // Cascades: ProductVariantOptionValue + BranchInventory are removed by the
    // schema-level `onDelete: Cascade` on their variant relations.
    await this.repo.deleteVariant(variantId);
    return { id: variantId };
  }

  // ── Image ──────────────────────────────────────────────────────────────────

  async setImage(
    tenantId: string,
    productId: string,
    variantId: string,
    file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<VariantView> {
    if (!file) throw new BadRequestException('No image file provided');
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);

    const url = await this.storage.saveImage(file);
    if (existing.imageUrl) {
      await this.storage.remove(existing.imageUrl);
    }
    await this.repo.updateVariant(variantId, { imageUrl: url });
    const fresh = await this.repo.findVariant(tenantId, productId, variantId);
    return toVariantView(fresh!);
  }

  async removeImage(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<VariantView> {
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);
    if (existing.imageUrl) {
      await this.storage.remove(existing.imageUrl);
    }
    await this.repo.updateVariant(variantId, { imageUrl: null });
    const fresh = await this.repo.findVariant(tenantId, productId, variantId);
    return toVariantView(fresh!);
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  async getInventory(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<{ branches: VariantBranchInventoryView[] }> {
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);

    const rows = await this.repo.listVariantInventory(tenantId, variantId);
    return {
      branches: rows.map((r) => ({
        branchId: r.branchId,
        branchName: r.branch.name,
        quantityOnHand: r.quantityOnHand.toString(),
        averageCost: r.averageCost?.toString() ?? null,
        reorderLevel: r.reorderLevel?.toString() ?? null,
      })),
    };
  }

  async getPurchases(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<VariantPurchaseView[]> {
    await this.assertProduct(tenantId, productId);
    const existing = await this.repo.findVariant(tenantId, productId, variantId);
    if (!existing) throw new NotFoundException(`Variant ${variantId} not found`);

    const rows = await this.repo.listVariantPurchases(tenantId, variantId);
    return rows.map((r) => ({
      receiptId: r.receipt.id,
      receiptNumber: r.receipt.receiptNumber,
      receivedAt: r.receipt.receivedAt,
      supplierId: r.receipt.supplier?.id ?? null,
      supplierName: r.receipt.supplier?.name ?? null,
      invoiceReference: r.receipt.invoiceReference,
      grnReference: r.receipt.grnReference,
      lotNumber: r.lotNumber,
      expiryDate: r.expiryDate,
      quantityReceived: r.quantityReceived.toString(),
      unitCost: r.unitCost.toString(),
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async assertProduct(tenantId: string, productId: string) {
    const product = await this.repo.findProductForTenant(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    return product;
  }
}

/**
 * Prisma unique-violation → 409, matching the products.service message idiom so
 * the wizard surfaces "A variant with this SKU already exists" verbatim.
 */
function mapWriteError(err: unknown): Error {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
    const which = target.includes('sku') ? 'SKU' : 'value';
    return new ConflictException(`A variant with this ${which} already exists`);
  }
  return err instanceof Error ? err : new BadRequestException('Could not save variant');
}

type VariantRow = {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  unitPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal | null;
  averageCost: Prisma.Decimal | null;
  reorderLevel: Prisma.Decimal | null;
  imageUrl: string | null;
  position: number;
  isActive: boolean;
  isDefault: boolean;
  optionValues: {
    dimensionId: string;
    optionId: string;
    dimension: { id: string; name: string };
    option: { id: string; name: string };
  }[];
};

function toVariantView(row: VariantRow): VariantView {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    barcode: row.barcode,
    unitPrice: row.unitPrice.toString(),
    costPrice: row.costPrice?.toString() ?? null,
    averageCost: row.averageCost?.toString() ?? null,
    reorderLevel: row.reorderLevel?.toString() ?? null,
    imageUrl: row.imageUrl,
    position: row.position,
    isActive: row.isActive,
    isDefault: row.isDefault,
    optionValues: row.optionValues.map((ov) => ({
      dimensionId: ov.dimensionId,
      optionId: ov.optionId,
      dimensionName: ov.dimension.name,
      optionName: ov.option.name,
    })),
  };
}
