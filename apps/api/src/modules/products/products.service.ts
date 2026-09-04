import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product, SellableKind, UserRole } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { mirrorExternalRef } from '../quickbooks/external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/pagination';
import { StorageService } from '../../common/storage/storage.service';
import { CatalogSyncProviderFactory } from '../providers/catalog/catalog-sync-provider.factory';
import { CatalogSyncResult, ProductCatalogShape } from '../providers/provider.types';
import { ProductAttributesService } from './product-attributes.service';
import { MockSyncSummary, ProductsRepository } from './products.repository';
import { CreateProductDto, type ProductFoodType } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { SearchProductsDto } from './dto/search-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

/**
 * A product row widened with the facts a variant product's price and SKU
 * actually live on (D44). `Product` remains structurally a subset, so every
 * existing consumer of the list endpoints keeps compiling and reading the same
 * fields.
 */
export type ManagedProductView = Product & {
  /** Active variants. 0 for a legacy single-SKU product. */
  variantCount: number;
  /** Cheapest / dearest active variant. Null when there are no variants. */
  variantPriceMin: number | null;
  variantPriceMax: number | null;
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly catalogProviders: CatalogSyncProviderFactory,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly attributes: ProductAttributesService,
  ) {}

  async list(tenantId: string, query: QueryProductsDto): Promise<Paginated<ManagedProductView>> {
    const [items, total] = await this.productsRepository.listManaged(
      tenantId,
      {
        search: query.search,
        categoryId: query.categoryId,
        subcategoryId: query.subcategoryId,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
        type: query.type,
        syncStatus: query.syncStatus,
        stockStatus: query.stockStatus,
      },
      query.skip,
      query.take,
    );
    return paginate(await this.withVariantPrices(tenantId, items), total, query.page, query.pageSize);
  }

  async search(tenantId: string, query: SearchProductsDto): Promise<Paginated<ManagedProductView>> {
    const [items, total] = await this.productsRepository.advancedSearch(
      tenantId,
      {
        name: query.name,
        sku: query.sku,
        categoryId: query.categoryId,
        subcategoryId: query.subcategoryId,
        isActive: query.isActive,
      },
      query.skip,
      query.take,
    );
    return paginate(await this.withVariantPrices(tenantId, items), total, query.page, query.pageSize);
  }

  /**
   * Widen a page of products with their active-variant count and price span.
   *
   * Purely additive: `unitPrice` and `sku` keep the exact values they had, so a
   * consumer that never learned about these fields behaves as before. Screens
   * that show a price for a VARIANT product read the span instead, because D44
   * makes the parent-level columns meaningless there.
   *
   * Variant-less products get `count: 0` and null bounds rather than a span
   * equal to their own price — "no variants" and "one variant priced the same"
   * are different facts, and a caller must be able to tell them apart.
   */
  private async withVariantPrices(
    tenantId: string,
    items: Product[],
  ): Promise<ManagedProductView[]> {
    const variantIds = items.filter((p) => p.hasVariants).map((p) => p.id);
    const summary = await this.productsRepository.variantPriceSummary(tenantId, variantIds);
    return items.map((p) => {
      const s = summary.get(p.id);
      return {
        ...p,
        variantCount: s?.count ?? 0,
        variantPriceMin: s?.min ?? null,
        variantPriceMax: s?.max ?? null,
      };
    });
  }

  async getById(tenantId: string, id: string): Promise<Product> {
    const product = await this.productsRepository.findByIdForTenant(tenantId, id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  /** Create a locally-managed product (not yet in QuickBooks → NOT_SYNCED). */
  async create(tenantId: string, dto: CreateProductDto): Promise<Product> {
    // D64 — the empty document counts as a full document, so a domain with
    // required attributes refuses a create that omits them entirely.
    await this.attributes.assertValidDocument(tenantId, dto.attributes ?? {});
    const link = await this.resolveCategoryLink(tenantId, dto.categoryId, dto.subcategoryId);
    const data: Prisma.ProductUncheckedCreateInput = {
      tenantId,
      name: dto.name,
      type: dto.type ?? 'Inventory',
      sku: dto.sku ?? null,
      description: dto.description ?? null,
      categoryId: link.categoryId ?? null,
      subcategoryId: link.subcategoryId ?? null,
      unitPrice: dto.unitPrice,
      purchaseDescription: dto.purchaseDescription ?? null,
      costPrice: dto.costPrice ?? null,
      quantityOnHand: dto.quantityOnHand ?? 0,
      quantityAsOfDate: dto.quantityAsOfDate ? new Date(dto.quantityAsOfDate) : new Date(),
      reorderLevel: dto.reorderLevel ?? null,
      isActive: dto.isActive ?? true,
      // D101 (3.13) — absent means taxable. A `false` default here would
      // zero-rate every product any client created without the field.
      taxable: dto.taxable ?? true,
      // Pre-uploaded URL from the Add Product wizard (D44); optional in every
      // other flow, which historically calls `POST /products/:id/image` after
      // create.
      imageUrl: dto.imageUrl ?? null,
      // D45 — Restaurant wizard fields. Stored as-is; no provider routing.
      // dietaryTags defaults to [] in the schema, but Prisma treats undefined
      // as "leave defaulted" only on update — on create the field is set to
      // whatever we pass, so we pass an explicit empty array to keep the
      // shape stable for Retail rows the wizard never touches.
      prepMinutes: dto.prepMinutes ?? null,
      dietaryTags: dto.dietaryTags ?? [],
      foodType: dto.foodType ?? null,
      // D64 — validated above; stored verbatim. The schema default covers the
      // omitted case, but passing it explicitly keeps create shape stable.
      attributes: (dto.attributes ?? {}) as Prisma.InputJsonValue,
      // D65 — the same classification rule the D60 backfill applied, now at
      // authoring time so new rows cannot drift from backfilled ones: a
      // Service is a SERVICE, a dish (foodType set) is COMPOSED_ITEM,
      // everything else is a plain STOCK_ITEM.
      sellableKind: deriveSellableKind(dto.type ?? 'Inventory', dto.foodType ?? null),
      syncStatus: 'NOT_SYNCED',
    };
    // One provider for the operation, resolved from the authenticated tenant before
    // any write. No profile conditional here: the provider decides whether an
    // external catalogue exists, and this method only applies the local consequence.
    const catalog = await this.catalogProviders.forTenant(tenantId);
    try {
      const created = await this.productsRepository.create(tenantId, data);
      const result = await catalog.productCreated({ tenantId, branchId: null }, toCatalogShape(created));
      return await this.applyCatalogSync(created, result);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Update a product. QuickBooks-managed products (those with a QBO item id) are
   * the inventory master, so their stock can't be edited unless the actor is an
   * owner/admin (explicit local override).
   */
  async update(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
    actorRole: UserRole,
  ): Promise<Product> {
    const existing = await this.getById(tenantId, id);

    // D64 — replace semantics: a provided document is validated whole
    // (required keys included); undefined leaves the stored one untouched.
    if (dto.attributes !== undefined) {
      await this.attributes.assertValidDocument(tenantId, dto.attributes);
    }

    const changingStock =
      dto.quantityOnHand !== undefined &&
      Number(dto.quantityOnHand) !== Number(existing.quantityOnHand);
    const isQuickBooksManaged = existing.quickbooksItemId != null;
    const isAdmin = actorRole === 'OWNER' || actorRole === 'ADMIN';
    if (changingStock && isQuickBooksManaged && !isAdmin) {
      throw new ForbiddenException(
        'Stock for QuickBooks-managed products is controlled by QuickBooks. Ask an owner/admin to override.',
      );
    }

    const link = await this.resolveCategoryLink(
      tenantId,
      dto.categoryId,
      dto.subcategoryId,
      existing.categoryId,
    );

    // Prisma treats `undefined` fields as "leave unchanged"; column names match the DTO.
    const data: Prisma.ProductUncheckedUpdateInput = {
      name: dto.name,
      type: dto.type,
      sku: dto.sku,
      description: dto.description,
      categoryId: link.categoryId,
      subcategoryId: link.subcategoryId,
      unitPrice: dto.unitPrice,
      purchaseDescription: dto.purchaseDescription,
      costPrice: dto.costPrice,
      quantityOnHand: dto.quantityOnHand,
      // Restating the count implies a fresh as-of date unless one was given.
      quantityAsOfDate: dto.quantityAsOfDate
        ? new Date(dto.quantityAsOfDate)
        : changingStock
          ? new Date()
          : undefined,
      reorderLevel: dto.reorderLevel,
      isActive: dto.isActive,
      // Undefined leaves the stored value alone; only an explicit boolean moves
      // it, so a partial update cannot make a product exempt by omission.
      taxable: dto.taxable,
      // Only forward `imageUrl` when the caller actually sent one — the field
      // is otherwise owned by `setImage` / `removeImage`, which take the file
      // path and manage storage.remove(). Skipping `undefined` keeps Prisma
      // from clobbering the existing value.
      ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}),
      // D45 — Restaurant wizard fields. Passed through unchanged. Prisma
      // treats `undefined` as "leave unchanged", which is the semantics the
      // wizard wants (a partial update from step 5 should not zero out the
      // fields that live on steps 1-4).
      prepMinutes: dto.prepMinutes,
      dietaryTags: dto.dietaryTags,
      foodType: dto.foodType,
      // D64 — undefined = leave unchanged (Prisma's semantics); a provided
      // document replaces the stored one wholesale.
      attributes: dto.attributes as Prisma.InputJsonValue | undefined,
      // D65 — re-derive ONLY when an input of the rule changes; an untouched
      // patch leaves the classification alone. (BUNDLE has no authoring
      // surface yet; when it does, this derivation moves behind it.)
      sellableKind:
        dto.type !== undefined || dto.foodType !== undefined
          ? deriveSellableKind(
              dto.type ?? existing.type,
              dto.foodType !== undefined ? dto.foodType : (existing.foodType as ProductFoodType | null),
            )
          : undefined,
    };
    const catalog = await this.catalogProviders.forTenant(tenantId);
    try {
      const updated = await this.productsRepository.update(id, data);
      // Whether a *mirrored* field changed, and whether the product is linked at
      // all, are the catalogue's own rules — moved into the provider unchanged.
      const result = await catalog.productUpdated(
        { tenantId, branchId: null },
        toCatalogShape(existing),
        toCatalogShape(updated),
      );
      return await this.applyCatalogSync(updated, result);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /** Soft-delete: deactivate rather than remove (sale history references it). */
  async deactivate(tenantId: string, id: string): Promise<Product> {
    await this.getById(tenantId, id);
    const catalog = await this.catalogProviders.forTenant(tenantId);
    const updated = await this.productsRepository.update(id, { isActive: false });
    const result = await catalog.productDeactivated(
      { tenantId, branchId: null },
      toCatalogShape(updated),
    );
    return this.applyCatalogSync(updated, result);
  }

  /**
   * Attach a POS-side product photo (S3 / LocalStack). Images are local to the
   * POS and are never pushed to QuickBooks.
   */
  async setImage(
    tenantId: string,
    id: string,
    file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<Product> {
    if (!file) {
      throw new BadRequestException('No image file provided');
    }
    const existing = await this.getById(tenantId, id);
    const url = await this.storage.saveImage(file);
    if (existing.imageUrl) {
      await this.storage.remove(existing.imageUrl);
    }
    return this.productsRepository.update(id, { imageUrl: url });
  }

  async removeImage(tenantId: string, id: string): Promise<Product> {
    const existing = await this.getById(tenantId, id);
    if (existing.imageUrl) {
      await this.storage.remove(existing.imageUrl);
    }
    return this.productsRepository.update(id, { imageUrl: null });
  }

  /**
   * Queue an explicit product push; the sync worker creates/updates the item.
   *
   * A tenant with no external catalogue gets a typed provider-not-supported refusal
   * from the provider rather than this method's QuickBooks-specific wording — the
   * operation genuinely does not exist for them. A QuickBooks tenant with no
   * connected company keeps the existing `'QuickBooks is not connected'` message,
   * verbatim, because that is the message the POS surfaces today.
   */
  async syncToQuickBooks(tenantId: string, id: string): Promise<Product> {
    await this.getById(tenantId, id);
    const catalog = await this.catalogProviders.forTenant(tenantId);
    const result = await catalog.pushProduct({ tenantId, branchId: null }, id);
    if (result.disposition !== 'QUEUED') {
      throw new BadRequestException('QuickBooks is not connected');
    }
    // D63 dual-write.
    await mirrorExternalRef(this.prisma, tenantId, 'PRODUCT', id, { syncStatus: 'PENDING' });
    return this.productsRepository.update(id, { syncStatus: 'PENDING' });
  }

  /**
   * Mock QuickBooks sync — refreshes the local product cache from the mock
   * catalog. Stock/prices are only ever updated via sync, never edited in the POS.
   */
  async mockSync(tenantId: string): Promise<MockSyncSummary> {
    const catalog = await this.catalogProviders.forTenant(tenantId);
    // The local refresh is passed in as a callback, so the provider decides whether
    // an external catalogue refresh is meaningful while the repository keeps owning
    // the write. A tenant with no external catalogue is refused, not silently no-op'd.
    const outcome = await catalog.refreshCatalogue({ tenantId, branchId: null }, () =>
      this.productsRepository.mockSync(tenantId),
    );
    return outcome.summary;
  }

  /**
   * Apply the LOCAL consequence of a catalogue submission.
   *
   * `QUEUED` records `PENDING`, which is exactly what `queueQuickBooksPush` did.
   * `NOT_CONNECTED` and `NOT_REQUIRED` both leave the row alone — the first because
   * that is today's behaviour when nothing was queued, the second because a tenant
   * with no external catalogue has nothing pending and must never be shown as
   * waiting for a push that will not happen.
   *
   * This is the only place a catalogue result touches persistence, and it is a
   * reaction to a provider-neutral disposition rather than a profile check.
   */
  private async applyCatalogSync(product: Product, result: CatalogSyncResult): Promise<Product> {
    if (result.disposition !== 'QUEUED') return product;
    // D63 dual-write.
    await mirrorExternalRef(this.prisma, product.tenantId, 'PRODUCT', product.id, {
      syncStatus: 'PENDING',
    });
    return this.productsRepository.update(product.id, { syncStatus: 'PENDING' });
  }



  /**
   * Validate + normalise the category ↔ subcategory link (spec §17): a chosen
   * subcategory must belong to the effective category, and selecting one keeps
   * `categoryId` aligned. A blank string or null clears the field; `undefined`
   * leaves it unchanged (update semantics). Null reaches us at runtime because
   * the web form sends `field || null` and @IsOptional lets null through.
   * Returns only the fields that should be written.
   */
  private async resolveCategoryLink(
    tenantId: string,
    categoryInput: string | null | undefined,
    subcategoryInput: string | null | undefined,
    existingCategoryId?: string | null,
  ): Promise<{ categoryId?: string | null; subcategoryId?: string | null }> {
    const out: { categoryId?: string | null; subcategoryId?: string | null } = {};

    if (categoryInput !== undefined) out.categoryId = categoryInput || null;

    if (subcategoryInput !== undefined) {
      if (!subcategoryInput) {
        out.subcategoryId = null;
      } else {
        const sub = await this.productsRepository.findSubcategory(tenantId, subcategoryInput);
        if (!sub) throw new BadRequestException('Subcategory not found');
        const effectiveCategory =
          out.categoryId !== undefined ? out.categoryId : (existingCategoryId ?? sub.categoryId);
        if (effectiveCategory && effectiveCategory !== sub.categoryId) {
          throw new BadRequestException('Subcategory does not belong to the selected category');
        }
        out.subcategoryId = sub.id;
        out.categoryId = sub.categoryId; // keep the two columns consistent
      }
    }

    return out;
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      const which = target.includes('sku') ? 'SKU' : 'value';
      return new ConflictException(`A product with this ${which} already exists`);
    }
    return err instanceof Error ? err : new BadRequestException('Could not save product');
  }
}

/**
 * Narrow a `Product` row to the facts a catalogue provider may read.
 *
 * `externalItemId` is the neutral name for `quickbooksItemId`: the port must not
 * name a vendor, and the field means "the identifier the external catalogue gave
 * this product" whichever catalogue that is. Quantities, images and category links
 * are deliberately not passed — a catalogue has no business reading them.
 */
/**
 * D65 — one classification rule for `sellableKind`, identical to the D60
 * backfill's Stage A, so an authored row and a backfilled row cannot
 * disagree. This is what the depletion engine branches on: SERVICE claims no
 * stock, COMPOSED_ITEM depletes via its recipe (or not at all without one),
 * STOCK_ITEM depletes 1:1.
 */
function deriveSellableKind(
  type: string,
  foodType: ProductFoodType | null,
): SellableKind {
  if (type === 'Service') return 'SERVICE';
  if (foodType != null) return 'COMPOSED_ITEM';
  return 'STOCK_ITEM';
}

function toCatalogShape(product: Product): ProductCatalogShape {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: product.id,
    name: product.name,
    type: product.type,
    sku: product.sku,
    description: product.description,
    purchaseDescription: product.purchaseDescription,
    unitPrice: num(product.unitPrice),
    costPrice: num(product.costPrice),
    isActive: product.isActive,
    externalItemId: product.quickbooksItemId,
  };
}
