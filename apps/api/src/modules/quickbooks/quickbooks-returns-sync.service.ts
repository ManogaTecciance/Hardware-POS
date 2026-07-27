import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from '../../common/money';
import { SettingsService } from '../settings/settings.service';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';
import {
  createCreditMemo,
  createRefundReceipt,
  type QboRef,
  type QboReturnDocumentInput,
  type QboSalesLine,
} from './quickbooks.api';

export interface ReturnSyncResult {
  returnId: string;
  returnNumber: string;
  status: 'SYNCED' | 'FAILED';
  quickbooksDocumentType: 'REFUND_RECEIPT' | 'CREDIT_MEMO' | null;
  quickbooksDocumentId: string | null;
  message: string;
}

type ReturnWithSyncRelations = Prisma.ReturnGetPayload<{
  include: {
    items: true;
    refundPayments: true;
    originalSale: { select: { saleNumber: true; paymentStatus: true } };
  };
}>;

const returnInclude = {
  items: true,
  refundPayments: true,
  originalSale: { select: { saleNumber: true, paymentStatus: true } },
} satisfies Prisma.ReturnInclude;

/**
 * Push a completed return to QuickBooks:
 *  - a Refund Receipt for a refunded (paid) sale, or
 *  - a Credit Memo for a credit / store-credit return.
 *
 * Mirrors {@link QuickBooksSalesSyncService}: same idempotency guard, mock
 * fallback when no company is connected, and persist-success/failure semantics.
 * On failure the return stays completed in the POS and is only marked FAILED
 * (never rolled back) — Rule 8. This worker pushes only the accounting document;
 * local stock is restocked eagerly in the return-creation transaction (see
 * returns.repository.ts), independent of QuickBooks connectivity. A later
 * product refresh reconciles the local cache to QuickBooks' absolute quantities.
 */
@Injectable()
export class QuickBooksReturnsSyncService {
  private readonly logger = new Logger(QuickBooksReturnsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
    private readonly settings: SettingsService,
  ) {}

  async syncReturn(tenantId: string, returnId: string): Promise<ReturnSyncResult> {
    const ret = await this.prisma.return.findFirst({
      where: { id: returnId, tenantId },
      include: returnInclude,
    });
    if (!ret) {
      throw new NotFoundException(`Return ${returnId} not found`);
    }
    if (ret.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed returns can be synced to QuickBooks');
    }

    // Idempotency: don't create a duplicate document for an already-synced return.
    if (ret.syncStatus === 'SYNCED' && ret.quickbooksDocumentId) {
      return this.result(ret, 'SYNCED', ret.quickbooksDocumentId, 'Return already synced');
    }

    const attempt = await this.nextAttempt(tenantId, returnId);
    await this.prisma.return.update({ where: { id: returnId }, data: { syncStatus: 'SYNCING' } });

    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      return this.mockSync(ret, attempt);
    }

    try {
      const accessToken = await this.oauth.getValidAccessToken(tenantId);
      const { apiBase } = this.config.resolve();
      const request = { apiBase, realmId: connection.realmId, accessToken };

      const customerRef = await this.resolveCustomerRef(tenantId, ret.customerId);
      const lines = await this.buildLines(tenantId, ret);
      const docBody = this.buildDocumentBody(tenantId, ret, lines, customerRef);

      let documentId: string;
      if (ret.quickbooksDocumentType === 'CREDIT_MEMO') {
        if (!customerRef) {
          throw new Error('Cannot create a Credit Memo: customer is not linked to QuickBooks');
        }
        const memo = await createCreditMemo(request, docBody);
        documentId = memo.Id;
      } else {
        const refund = await createRefundReceipt(request, docBody);
        documentId = refund.Id;
      }

      await this.persistSuccess(ret, documentId, attempt);
      this.logger.log(
        `Synced return ${ret.returnNumber} → ${ret.quickbooksDocumentType} ${documentId}`,
      );
      return this.result(ret, 'SYNCED', documentId, `${ret.quickbooksDocumentType} ${documentId} created`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'QuickBooks return sync failed';
      await this.persistFailure(ret, message, attempt);
      this.logger.warn(`Return ${ret.returnNumber} sync failed: ${message}`);
      return this.result(ret, 'FAILED', ret.quickbooksDocumentId, message);
    }
  }

  /** Simulated push used when no company is connected (dev/demo). */
  private async mockSync(ret: ReturnWithSyncRelations, attempt: number): Promise<ReturnSyncResult> {
    const prefix = ret.quickbooksDocumentType === 'CREDIT_MEMO' ? 'CM' : 'RR';
    const documentId = ret.quickbooksDocumentId ?? `QBO-${prefix}-${ret.returnNumber}`;
    await this.persistSuccess(ret, documentId, attempt);
    this.logger.log(
      `Simulated QuickBooks sync for return ${ret.returnNumber} (not connected) → ${documentId}`,
    );
    return this.result(
      ret,
      'SYNCED',
      documentId,
      `Simulated ${ret.quickbooksDocumentType} ${documentId} (QuickBooks not connected)`,
    );
  }

  /** Retry a previously-failed return sync identified by its sync-log id. */
  async retry(tenantId: string, syncLogId: string): Promise<ReturnSyncResult> {
    const log = await this.prisma.syncLog.findFirst({ where: { id: syncLogId, tenantId } });
    if (!log) {
      throw new NotFoundException(`Sync log ${syncLogId} not found`);
    }
    if (log.entityType !== 'RETURN' || !log.entityId) {
      throw new BadRequestException('Sync log does not reference a return');
    }
    return this.syncReturn(tenantId, log.entityId);
  }

  // ── document building ──────────────────────────────────────────────────────

  private async buildLines(
    tenantId: string,
    ret: ReturnWithSyncRelations,
  ): Promise<QboSalesLine[]> {
    const productIds = [...new Set(ret.items.map((it) => it.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, quickbooksItemId: true },
    });
    const itemIdByProduct = new Map(products.map((p) => [p.id, p.quickbooksItemId]));

    return ret.items.map((item) => {
      const quantity = Number(item.returnQuantity);
      const unitPrice = Number(item.originalUnitPrice);
      const discountAdjustment =
        Number(item.productDiscountAdjustment) + Number(item.orderDiscountAdjustment);
      // Refund documents carry positive line amounts; the document type (Refund
      // Receipt / Credit Memo) is what makes it a credit to the customer.
      const amount = Number(item.refundableAmount) - Number(item.taxAdjustment);

      const quickbooksItemId = itemIdByProduct.get(item.productId);
      const detail: QboSalesLine['SalesItemLineDetail'] = { Qty: quantity };
      if (quickbooksItemId) detail.ItemRef = { value: quickbooksItemId };
      if (discountAdjustment === 0) detail.UnitPrice = unitPrice;

      const conditionNote = `${humanize(item.returnReason)} · ${humanize(item.itemCondition)} · ${humanize(item.stockDisposition)}`;
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: round2(amount),
        Description: `${item.productNameSnapshot} (return: ${conditionNote})`,
        SalesItemLineDetail: detail,
      };
    });
  }

  private buildDocumentBody(
    tenantId: string,
    ret: ReturnWithSyncRelations,
    lines: QboSalesLine[],
    customerRef: QboRef | null,
  ): QboReturnDocumentInput {
    const body: QboReturnDocumentInput = {
      DocNumber: ret.returnNumber,
      PrivateNote: `POS return ${ret.returnNumber} against sale ${ret.originalSale.saleNumber}`,
      Line: lines,
    };
    if (customerRef) body.CustomerRef = customerRef;

    const taxAdjustment = Number(ret.taxAdjustment);
    if (taxAdjustment > 0) body.TxnTaxDetail = { TotalTax: taxAdjustment };

    // TODO(accountant): a Refund Receipt normally names the account the money is
    // paid back from (DepositToAccountRef) and, optionally, a PaymentMethodRef.
    const depositRef = this.settings.getSettings(tenantId).returns
      .quickbooksRefundReceiptDepositAccountRef;
    if (ret.quickbooksDocumentType === 'REFUND_RECEIPT' && depositRef) {
      body.DepositToAccountRef = { value: depositRef };
    }
    return body;
  }

  private async resolveCustomerRef(
    tenantId: string,
    customerId: string | null,
  ): Promise<QboRef | null> {
    if (!customerId) return null;
    const mapping = await this.prisma.quickBooksMapping.findUnique({
      where: {
        tenantId_entityType_localId: { tenantId, entityType: 'CUSTOMER', localId: customerId },
      },
    });
    return mapping ? { value: mapping.quickbooksId } : null;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private async persistSuccess(
    ret: ReturnWithSyncRelations,
    documentId: string,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.return.update({
        where: { id: ret.id },
        data: { syncStatus: 'SYNCED', quickbooksDocumentId: documentId, syncError: null },
      });
      await tx.refundPayment.updateMany({
        where: { returnId: ret.id },
        data: { syncStatus: 'SYNCED', quickbooksPaymentId: documentId },
      });
      await tx.syncJob.updateMany({
        where: {
          tenantId: ret.tenantId,
          entityType: 'RETURN',
          entityId: ret.id,
          status: { in: ['PENDING', 'SYNCING', 'FAILED'] },
        },
        data: { status: 'SYNCED', completedAt: new Date(), lastError: null },
      });

      // NOTE: local stock restock is NOT done here. It happens eagerly in the
      // return-creation transaction (returns.repository.ts) so local inventory
      // is correct the instant a return completes, independent of QuickBooks
      // connectivity. This worker only pushes the accounting document.
      await tx.syncLog.create({
        data: {
          tenantId: ret.tenantId,
          entityType: 'RETURN',
          entityId: ret.id,
          direction: 'OUTBOUND',
          status: 'SYNCED',
          attempt,
          message: `${ret.quickbooksDocumentType} ${documentId} created in QuickBooks`,
          payload: {
            quickbooksDocumentType: ret.quickbooksDocumentType,
            quickbooksDocumentId: documentId,
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  private async persistFailure(
    ret: ReturnWithSyncRelations,
    message: string,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Rule 8: keep the return saved in the POS; only mark the sync failed.
      await tx.return.update({
        where: { id: ret.id },
        data: { syncStatus: 'FAILED', syncError: message },
      });
      await tx.syncJob.updateMany({
        where: {
          tenantId: ret.tenantId,
          entityType: 'RETURN',
          entityId: ret.id,
          status: { in: ['PENDING', 'SYNCING'] },
        },
        data: { status: 'FAILED', lastError: message },
      });
      await tx.syncLog.create({
        data: {
          tenantId: ret.tenantId,
          entityType: 'RETURN',
          entityId: ret.id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          attempt,
          message,
        },
      });
    });
  }

  private async nextAttempt(tenantId: string, returnId: string): Promise<number> {
    const last = await this.prisma.syncLog.findFirst({
      where: { tenantId, entityType: 'RETURN', entityId: returnId, direction: 'OUTBOUND' },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    return (last?.attempt ?? 0) + 1;
  }

  private result(
    ret: ReturnWithSyncRelations,
    status: 'SYNCED' | 'FAILED',
    documentId: string | null,
    message: string,
  ): ReturnSyncResult {
    return {
      returnId: ret.id,
      returnNumber: ret.returnNumber,
      status,
      quickbooksDocumentType: ret.quickbooksDocumentType,
      quickbooksDocumentId: documentId,
      message,
    };
  }
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
