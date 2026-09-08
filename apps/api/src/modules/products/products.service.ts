import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product, UserRole } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { StorageService } from '../../common/storage/storage.service';
import { isAdminLevelRole } from '../auth/permissions';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { MockSyncSummary, ProductsRepository } from './products.repository';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { SearchProductsDto } from './dto/search-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly syncQueue: SyncQueueService,
    private readonly storage: StorageService,
  ) {}

  async list(tenantId: string, query: QueryProductsDto): Promise<Paginated<Product>> {
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
    return paginate(items, total, query.page, query.pageSize);
  }

  async search(tenantId: string, query: SearchProductsDto): Promise<Paginated<Product>> {
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
    return paginate(items, total, query.page, query.pageSize);
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
      syncStatus: 'NOT_SYNCED',
    };
    try {
      const created = await this.productsRepository.create(tenantId, data);
      // New products flow to QuickBooks automatically when it is connected.
      return await this.queueQuickBooksPush(tenantId, created);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Update a product. QuickBooks-managed products (those with a QBO item id) are
   * the inventory master, so their stock can't be edited unless the actor holds
   * an owner-level role (explicit local override).
   */
  async update(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
    actorRole: UserRole,
  ): Promise<Product> {
    const existing = await this.getById(tenantId, id);

    const changingStock =
      dto.quantityOnHand !== undefined &&
      Number(dto.quantityOnHand) !== Number(existing.quantityOnHand);
    const isQuickBooksManaged = existing.quickbooksItemId != null;
    const isAdmin = isAdminLevelRole(actorRole);
    if (changingStock && isQuickBooksManaged && !isAdmin) {
      throw new ForbiddenException(
        'Stock for QuickBooks-managed products is controlled by QuickBooks. Ask someone with owner-level access to override.',
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
    };
    try {
      const updated = await this.productsRepository.update(id, data);
      // Push QBO-relevant edits of a linked product back to QuickBooks.
      if (existing.quickbooksItemId != null && this.qboFieldsChanged(existing, updated)) {
        return await this.queueQuickBooksPush(tenantId, updated);
      }
      return updated;
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /** Soft-delete: deactivate rather than remove (sale history references it). */
  async deactivate(tenantId: string, id: string): Promise<Product> {
    const existing = await this.getById(tenantId, id);
    const updated = await this.productsRepository.update(id, { isActive: false });
    // Deactivating a QBO-linked product marks the QBO item inactive too.
    if (existing.quickbooksItemId != null) {
      return this.queueQuickBooksPush(tenantId, updated);
    }
    return updated;
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

  /** Queue a product push to QuickBooks; the sync worker creates/updates the Item. */
  async syncToQuickBooks(tenantId: string, id: string): Promise<Product> {
    await this.getById(tenantId, id);
    const queued = await this.syncQueue.enqueueProductSync(tenantId, id);
    if (!queued) {
      throw new BadRequestException('QuickBooks is not connected');
    }
    return this.productsRepository.update(id, { syncStatus: 'PENDING' });
  }

  /**
   * Mock QuickBooks sync — refreshes the local product cache from the mock
   * catalog. Stock/prices are only ever updated via sync, never edited in the POS.
   */
  mockSync(tenantId: string): Promise<MockSyncSummary> {
    return this.productsRepository.mockSync(tenantId);
  }

  /**
   * Best-effort enqueue of an outbound product push. Returns the product with
   * PENDING sync status when queued; unchanged when QuickBooks is not connected.
   */
  private async queueQuickBooksPush(tenantId: string, product: Product): Promise<Product> {
    const queued = await this.syncQueue.enqueueProductSync(tenantId, product.id);
    if (!queued) return product;
    return this.productsRepository.update(product.id, { syncStatus: 'PENDING' });
  }

  /** Did any field that QuickBooks mirrors change between the two rows? */
  private qboFieldsChanged(before: Product, after: Product): boolean {
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    return (
      before.name !== after.name ||
      before.type !== after.type ||
      before.sku !== after.sku ||
      before.description !== after.description ||
      before.purchaseDescription !== after.purchaseDescription ||
      num(before.unitPrice) !== num(after.unitPrice) ||
      num(before.costPrice) !== num(after.costPrice) ||
      before.isActive !== after.isActive
    );
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
