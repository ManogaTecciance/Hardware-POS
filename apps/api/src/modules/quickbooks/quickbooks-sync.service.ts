import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { mirrorExternalRef } from './external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';
import { queryItems, type QboItem } from './quickbooks.api';

export interface SyncProductsSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
}

/** QuickBooks item types we import into the local product cache. */
const IMPORTABLE_TYPES = new Set(['Inventory', 'NonInventory']);

@Injectable()
export class QuickBooksSyncService {
  private readonly logger = new Logger(QuickBooksSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  /**
   * Pull inventory + non-inventory items from QuickBooks and upsert them into the
   * local Product cache. Uses the stored token (refreshing if expired), records a
   * sync log, and returns per-item counts.
   */
  async syncProducts(tenantId: string): Promise<SyncProductsSummary> {
    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      throw new NotFoundException('QuickBooks is not connected');
    }

    const accessToken = await this.oauth.getValidAccessToken(tenantId); // refreshes if expired
    const { apiBase } = this.config.resolve();

    const items = await queryItems({ apiBase, realmId: connection.realmId, accessToken });

    // QBO product categories are Item rows too (Type=Category) — mirror them
    // locally first so products can link to them via ParentRef.
    const categoryByQboId = await this.syncCategories(tenantId, items);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      if (!item.Type || !IMPORTABLE_TYPES.has(item.Type)) {
        skipped++;
        continue;
      }
      try {
        const categoryId = item.ParentRef ? (categoryByQboId.get(item.ParentRef.value) ?? null) : null;
        const outcome = await this.upsertItem(tenantId, item, categoryId);
        if (outcome === 'created') created++;
        else updated++;
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to sync item ${item.Id}: ${(err as Error).message}`);
      }
    }

    const summary: SyncProductsSummary = { created, updated, skipped, failed, total: items.length };

    await this.prisma.syncLog.create({
      data: {
        tenantId,
        entityType: 'PRODUCT',
        entityId: null,
        direction: 'INBOUND',
        status: failed > 0 ? 'FAILED' : 'SYNCED',
        message: `QuickBooks product sync: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed`,
      },
    });

    this.logger.log(`QuickBooks product sync for ${tenantId}: ${JSON.stringify(summary)}`);
    return summary;
  }

  private async upsertItem(
    tenantId: string,
    item: QboItem,
    categoryId: string | null,
  ): Promise<'created' | 'updated'> {
    const quickbooksItemId = String(item.Id);
    const existing = await this.prisma.product.findUnique({
      where: { tenantId_quickbooksItemId: { tenantId, quickbooksItemId } },
    });

    const data = {
      name: item.Name,
      sku: item.Sku ?? null,
      description: item.Description ?? null,
      purchaseDescription: item.PurchaseDesc ?? null,
      unitPrice: item.UnitPrice ?? 0,
      costPrice: item.PurchaseCost ?? null,
      quantityOnHand: item.QtyOnHand ?? 0,
      quantityAsOfDate: item.InvStartDate ? new Date(item.InvStartDate) : null,
      type: item.Type ?? 'Inventory',
      incomeAccount: item.IncomeAccountRef?.name ?? null,
      expenseAccount: item.ExpenseAccountRef?.name ?? null,
      inventoryAssetAccount: item.AssetAccountRef?.name ?? null,
      isActive: item.Active ?? true,
      // Only assign when QBO names a known category — never wipe a manual one.
      ...(categoryId ? { categoryId } : {}),
      syncStatus: 'SYNCED' as const,
      lastSyncedAt: new Date(),
    };

    const upserted = await this.prisma.product.upsert({
      where: { tenantId_quickbooksItemId: { tenantId, quickbooksItemId } },
      update: data,
      create: { tenantId, quickbooksItemId, ...data },
    });
    // D63 dual-write.
    await mirrorExternalRef(this.prisma, tenantId, 'PRODUCT', upserted.id, {
      externalId: quickbooksItemId,
      syncStatus: 'SYNCED',
      lastSyncedAt: new Date(),
    });

    return existing ? 'updated' : 'created';
  }

  /**
   * Mirror QBO Category items as local ProductCategory rows (matched by their
   * QBO item id, falling back to name for pre-existing local categories).
   * Returns QBO category id → local category id.
   */
  private async syncCategories(tenantId: string, items: QboItem[]): Promise<Map<string, string>> {
    const localIdByQboId = new Map<string, string>();
    for (const item of items) {
      if (item.Type !== 'Category') continue;
      const qboId = String(item.Id);
      let category = await this.prisma.productCategory.findFirst({
        where: { tenantId, OR: [{ quickbooksItemId: qboId }, { name: item.Name }] },
      });
      if (category) {
        if (category.quickbooksItemId !== qboId || !category.isActive) {
          category = await this.prisma.productCategory.update({
            where: { id: category.id },
            data: { quickbooksItemId: qboId, isActive: true },
          });
        }
      } else {
        category = await this.prisma.productCategory.create({
          data: { tenantId, quickbooksItemId: qboId, name: item.Name },
        });
      }
      // D63 dual-write.
      await mirrorExternalRef(this.prisma, tenantId, 'PRODUCT_CATEGORY', category.id, {
        externalId: qboId,
        syncStatus: 'SYNCED',
        lastSyncedAt: new Date(),
      });
      localIdByQboId.set(qboId, category.id);
    }
    return localIdByQboId;
  }
}
