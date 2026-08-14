import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Product } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';
import {
  createItem,
  queryAccounts,
  queryItemById,
  updateItemSparse,
  type QboAccount,
} from './quickbooks.api';

export interface ProductSyncResult {
  productId: string;
  status: 'SYNCED' | 'FAILED' | 'SKIPPED';
  quickbooksItemId: string | null;
  message: string;
}

/** How long resolved account refs stay cached before re-querying QBO. */
const ACCOUNTS_TTL_MS = 15 * 60_000;

interface CachedAccounts {
  income: QboAccount;
  cogs: QboAccount;
  asset: QboAccount;
  fetchedAt: number;
}

/**
 * Pushes a locally-created product to QuickBooks: creates the Item on first
 * sync (storing the returned QBO item id) and sparse-updates name/price/cost
 * on later syncs. Quantity is deliberately never written on update — QBO owns
 * stock, and quantity changes there come from sales/returns documents.
 */
@Injectable()
export class QuickBooksProductSyncService {
  private readonly logger = new Logger(QuickBooksProductSyncService.name);
  private readonly accountsCache = new Map<string, CachedAccounts>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  async syncProduct(tenantId: string, productId: string): Promise<ProductSyncResult> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId } });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      return this.markFailed(tenantId, product, 'QuickBooks is not connected');
    }

    try {
      const accessToken = await this.oauth.getValidAccessToken(tenantId);
      const { apiBase } = this.config.resolve();
      const params = { apiBase, realmId: connection.realmId, accessToken };

      const isInventory = product.type === 'Inventory';
      const accounts = await this.resolveAccounts(tenantId, params);

      let quickbooksItemId = product.quickbooksItemId;
      let action: 'created' | 'updated';
      if (quickbooksItemId) {
        const remote = await queryItemById(params, quickbooksItemId);
        if (!remote?.SyncToken) {
          return this.markFailed(
            tenantId,
            product,
            `QuickBooks item ${quickbooksItemId} no longer exists — re-link or re-create it`,
          );
        }
        await updateItemSparse(params, {
          Id: remote.Id,
          SyncToken: remote.SyncToken,
          Name: product.name,
          ...(product.sku ? { Sku: product.sku } : {}),
          ...(product.description ? { Description: product.description } : {}),
          ...(product.purchaseDescription ? { PurchaseDesc: product.purchaseDescription } : {}),
          UnitPrice: Number(product.unitPrice),
          ...(product.costPrice != null ? { PurchaseCost: Number(product.costPrice) } : {}),
          Active: product.isActive,
        });
        action = 'updated';
      } else {
        const body: Record<string, unknown> = {
          Name: product.name,
          ...(product.sku ? { Sku: product.sku } : {}),
          ...(product.description ? { Description: product.description } : {}),
          ...(product.purchaseDescription ? { PurchaseDesc: product.purchaseDescription } : {}),
          UnitPrice: Number(product.unitPrice),
          ...(product.costPrice != null ? { PurchaseCost: Number(product.costPrice) } : {}),
          IncomeAccountRef: { value: accounts.income.Id },
          ExpenseAccountRef: { value: accounts.cogs.Id },
          ...(isInventory
            ? {
                Type: 'Inventory',
                TrackQtyOnHand: true,
                QtyOnHand: Number(product.quantityOnHand),
                InvStartDate: (product.quantityAsOfDate ?? new Date()).toISOString().slice(0, 10),
                AssetAccountRef: { value: accounts.asset.Id },
              }
            : { Type: product.type === 'Service' ? 'Service' : 'NonInventory' }),
        };
        const created = await createItem(params, body);
        quickbooksItemId = created.Id;
        action = 'created';
      }

      await this.prisma.$transaction([
        this.prisma.product.update({
          where: { id: product.id },
          data: {
            quickbooksItemId,
            // Mirror the resolved account names for read-only display.
            incomeAccount: accounts.income.Name,
            expenseAccount: accounts.cogs.Name,
            ...(isInventory ? { inventoryAssetAccount: accounts.asset.Name } : {}),
            syncStatus: 'SYNCED',
            lastSyncedAt: new Date(),
          },
        }),
        // D63 dual-write.
        this.prisma.externalEntityRef.upsert({
          where: {
            tenantId_provider_entityType_localId: {
              tenantId,
              provider: 'QUICKBOOKS',
              entityType: 'PRODUCT',
              localId: product.id,
            },
          },
          update: { externalId: quickbooksItemId, syncStatus: 'SYNCED', syncError: null, lastSyncedAt: new Date() },
          create: {
            tenantId,
            provider: 'QUICKBOOKS',
            entityType: 'PRODUCT',
            localId: product.id,
            externalId: quickbooksItemId,
            syncStatus: 'SYNCED',
            lastSyncedAt: new Date(),
          },
        }),
        this.prisma.syncLog.create({
          data: {
            tenantId,
            entityType: 'PRODUCT',
            entityId: product.id,
            direction: 'OUTBOUND',
            status: 'SYNCED',
            message: `Product "${product.name}" ${action} in QuickBooks (item ${quickbooksItemId})`,
          },
        }),
      ]);

      this.logger.log(`Product ${product.id} ${action} in QuickBooks as item ${quickbooksItemId}`);
      return {
        productId,
        status: 'SYNCED',
        quickbooksItemId,
        message: `Product "${product.name}" ${action} in QuickBooks`,
      };
    } catch (err) {
      return this.markFailed(tenantId, product, (err as Error).message);
    }
  }

  private async markFailed(
    tenantId: string,
    product: Product,
    message: string,
  ): Promise<ProductSyncResult> {
    this.logger.warn(`Product ${product.id} push failed: ${message}`);
    await this.prisma.$transaction([
      this.prisma.product.update({
        where: { id: product.id },
        data: { syncStatus: 'FAILED' },
      }),
      // D63 dual-write.
      this.prisma.externalEntityRef.upsert({
        where: {
          tenantId_provider_entityType_localId: {
            tenantId,
            provider: 'QUICKBOOKS',
            entityType: 'PRODUCT',
            localId: product.id,
          },
        },
        update: { syncStatus: 'FAILED', syncError: message },
        create: {
          tenantId,
          provider: 'QUICKBOOKS',
          entityType: 'PRODUCT',
          localId: product.id,
          syncStatus: 'FAILED',
          syncError: message,
        },
      }),
      this.prisma.syncLog.create({
        data: {
          tenantId,
          entityType: 'PRODUCT',
          entityId: product.id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          message: `Product "${product.name}" push failed: ${message}`,
        },
      }),
    ]);
    return { productId: product.id, status: 'FAILED', quickbooksItemId: product.quickbooksItemId, message };
  }

  /** Standard account refs (Income / COGS / Inventory Asset), cached per tenant. */
  private async resolveAccounts(
    tenantId: string,
    params: { apiBase: string; realmId: string; accessToken: string },
  ): Promise<CachedAccounts> {
    const cached = this.accountsCache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < ACCOUNTS_TTL_MS) return cached;

    const accounts = await queryAccounts(params);
    const income =
      accounts.find((a) => a.AccountSubType === 'SalesOfProductIncome') ??
      accounts.find((a) => a.AccountType === 'Income');
    const cogs =
      accounts.find((a) => a.AccountSubType === 'SuppliesMaterialsCogs') ??
      accounts.find((a) => a.AccountType === 'Cost of Goods Sold');
    const asset =
      accounts.find((a) => a.AccountSubType === 'Inventory') ??
      accounts.find((a) => a.AccountType === 'Other Current Asset');
    if (!income || !cogs || !asset) {
      throw new Error(
        'QuickBooks company is missing a standard Income / Cost of Goods Sold / Inventory Asset account',
      );
    }
    const resolved: CachedAccounts = { income, cogs, asset, fetchedAt: Date.now() };
    this.accountsCache.set(tenantId, resolved);
    return resolved;
  }
}
