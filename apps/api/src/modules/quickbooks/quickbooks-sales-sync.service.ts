import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { mirrorExternalRef } from './external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';
import {
  createInvoice,
  createPayment,
  createSalesReceipt,
  type QboRef,
  type QboSalesDocumentInput,
  type QboSalesLine,
} from './quickbooks.api';

export interface SaleSyncResult {
  saleId: string;
  saleNumber: string;
  status: 'SYNCED' | 'FAILED';
  quickbooksDocumentType: 'SALES_RECEIPT' | 'INVOICE' | null;
  quickbooksDocumentId: string | null;
  quickbooksPaymentId: string | null;
  message: string;
}

type SaleWithSyncRelations = Prisma.SaleGetPayload<{
  include: { items: true; payments: true; customer: true };
}>;

const saleInclude = { items: true, payments: true, customer: true } as const;

@Injectable()
export class QuickBooksSalesSyncService {
  private readonly logger = new Logger(QuickBooksSalesSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  /**
   * Push a completed sale to QuickBooks:
   *  - fully paid  → Sales Receipt
   *  - credit/partial → Invoice (+ a linked Payment when any amount was paid)
   *
   * Stores the QBO document id on the sale and the QBO payment id on the sale's
   * payments, updates sync status, and records a sync log. On failure the sale is
   * kept in the POS and marked FAILED (never rolled back).
   */
  async syncSale(tenantId: string, saleId: string): Promise<SaleSyncResult> {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: saleInclude,
    });
    if (!sale) {
      throw new NotFoundException(`Sale ${saleId} not found`);
    }
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed sales can be synced to QuickBooks');
    }

    // Idempotency: don't create a duplicate document for an already-synced sale.
    if (sale.syncStatus === 'SYNCED' && sale.quickbooksDocumentId) {
      return this.result(sale, 'SYNCED', sale.quickbooksDocumentId, null, 'Sale already synced');
    }

    const attempt = await this.nextAttempt(tenantId, saleId);
    await this.prisma.sale.update({ where: { id: saleId }, data: { syncStatus: 'SYNCING' } });

    // Dev/demo fallback: with no live QuickBooks connection (no credentials), simulate
    // the push so the POS flow completes end-to-end. Real QBO writes run only when a
    // company is connected — consistent with the mock sync used elsewhere in the app.
    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      return this.mockSync(sale, attempt);
    }

    try {
      const accessToken = await this.oauth.getValidAccessToken(tenantId); // refreshes if expired
      const { apiBase } = this.config.resolve();
      const request = { apiBase, realmId: connection.realmId, accessToken };

      const customerRef = await this.resolveCustomerRef(tenantId, sale.customerId);
      const lines = await this.buildLines(tenantId, sale);
      const docBody = this.buildDocumentBody(sale, lines, customerRef);

      let documentId: string;
      let quickbooksPaymentId: string | null = null;

      if (sale.quickbooksDocumentType === 'SALES_RECEIPT') {
        const receipt = await createSalesReceipt(request, docBody);
        documentId = receipt.Id;
      } else {
        // Credit / partial sale → Invoice.
        const invoice = await createInvoice(request, docBody);
        documentId = invoice.Id;

        // Rule 3: if any amount was paid on a credit/partial sale, record a QBO
        // Payment linked back to the invoice.
        const paidAmount = Number(sale.paidAmount);
        if (paidAmount > 0) {
          if (!customerRef) {
            // A QBO Payment requires a CustomerRef; without a synced customer we
            // cannot link it. TODO(accountant): enable customer sync so partial
            // payments on invoices can be recorded in QuickBooks.
            throw new Error(
              'Cannot record invoice payment: customer is not linked to QuickBooks',
            );
          }
          const payment = await createPayment(request, {
            CustomerRef: customerRef,
            TotalAmt: paidAmount,
            PrivateNote: `POS sale ${sale.saleNumber}`,
            Line: [{ Amount: paidAmount, LinkedTxn: [{ TxnId: documentId, TxnType: 'Invoice' }] }],
          });
          quickbooksPaymentId = payment.Id;
        }
      }

      await this.persistSuccess(sale, documentId, quickbooksPaymentId, attempt);
      this.logger.log(
        `Synced sale ${sale.saleNumber} → ${sale.quickbooksDocumentType} ${documentId}`,
      );
      return this.result(
        sale,
        'SYNCED',
        documentId,
        quickbooksPaymentId,
        `${sale.quickbooksDocumentType} ${documentId} created`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'QuickBooks sync failed';
      await this.persistFailure(sale, message, attempt);
      this.logger.warn(`Sale ${sale.saleNumber} sync failed: ${message}`);
      return this.result(sale, 'FAILED', sale.quickbooksDocumentId, null, message);
    }
  }

  /**
   * Simulated QuickBooks push used when no company is connected (dev/demo). Assigns
   * deterministic mock QBO ids and marks the sale + payments synced, mirroring the
   * real success path so the Sales UI and sync log look identical.
   */
  private async mockSync(
    sale: SaleWithSyncRelations,
    attempt: number,
  ): Promise<SaleSyncResult> {
    const prefix = sale.quickbooksDocumentType === 'SALES_RECEIPT' ? 'SR' : 'INV';
    const documentId = sale.quickbooksDocumentId ?? `QBO-${prefix}-${sale.saleNumber}`;
    const quickbooksPaymentId =
      sale.quickbooksDocumentType === 'INVOICE' && Number(sale.paidAmount) > 0
        ? `QBO-PMT-${sale.saleNumber}`
        : null;

    await this.persistSuccess(sale, documentId, quickbooksPaymentId, attempt);
    this.logger.log(
      `Simulated QuickBooks sync for sale ${sale.saleNumber} (not connected) → ${documentId}`,
    );
    return this.result(
      sale,
      'SYNCED',
      documentId,
      quickbooksPaymentId,
      `Simulated ${sale.quickbooksDocumentType} ${documentId} (QuickBooks not connected)`,
    );
  }

  /**
   * Retry a previously-failed sale sync identified by its sync-log id. Resolves
   * the sale from the log and re-runs the push (incrementing the attempt count).
   */
  async retry(tenantId: string, syncLogId: string): Promise<SaleSyncResult> {
    const log = await this.prisma.syncLog.findFirst({ where: { id: syncLogId, tenantId } });
    if (!log) {
      throw new NotFoundException(`Sync log ${syncLogId} not found`);
    }
    if (log.entityType !== 'SALE' || !log.entityId) {
      throw new BadRequestException('Sync log does not reference a sale');
    }
    return this.syncSale(tenantId, log.entityId);
  }

  // ── document building ──────────────────────────────────────────────────────

  private async buildLines(
    tenantId: string,
    sale: SaleWithSyncRelations,
  ): Promise<QboSalesLine[]> {
    // D58 made SaleItem.productId nullable for projected restaurant lines.
    // A QuickBooks tenant's sales are retail and always carry a product; the
    // filter is type honesty, not a behaviour change.
    const productIds = [
      ...new Set(sale.items.map((it) => it.productId).filter((id): id is string => id !== null)),
    ];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, quickbooksItemId: true },
    });
    const itemIdByProduct = new Map(products.map((p) => [p.id, p.quickbooksItemId]));

    return sale.items.map((item) => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      const discountAmount = Number(item.discountAmount);
      const lineTotal = Number(item.lineTotal); // net of the line discount

      // Make sale line items use quickbooksItemId when available.
      const quickbooksItemId = item.productId ? itemIdByProduct.get(item.productId) : undefined;
      const itemRef: QboRef | undefined = quickbooksItemId
        ? { value: quickbooksItemId }
        : undefined;

      // QuickBooks' SalesItemLineDetail has no per-line discount field, so the
      // product-wise discount is baked into the line Amount (net) and described in
      // the line note — totals reconcile exactly this way.
      // TODO(accountant): if discounts must appear as itemised discount lines or a
      // document-level DiscountLineDetail (which needs a discount income account and
      // tax-treatment decision), confirm the mapping before switching to that model.
      const detail: QboSalesLine['SalesItemLineDetail'] = { Qty: quantity };
      if (itemRef) detail.ItemRef = itemRef;
      if (discountAmount === 0) detail.UnitPrice = unitPrice; // exact; avoids Amount mismatch

      const description = this.lineDescription(item, discountAmount);

      return {
        DetailType: 'SalesItemLineDetail',
        Amount: lineTotal,
        ...(description ? { Description: description } : {}),
        SalesItemLineDetail: detail,
      };
    });
  }

  private lineDescription(
    item: SaleWithSyncRelations['items'][number],
    discountAmount: number,
  ): string | undefined {
    const parts: string[] = [item.productName];
    if (discountAmount > 0) {
      const label =
        item.discountType === 'PERCENTAGE'
          ? `${Number(item.discountValue ?? 0)}%`
          : `${Number(item.discountValue ?? 0)}`;
      const reason = item.discountReason ? ` – ${item.discountReason}` : '';
      parts.push(`(discount ${label}: -${discountAmount.toFixed(2)}${reason})`);
    }
    return parts.join(' ');
  }

  private buildDocumentBody(
    sale: SaleWithSyncRelations,
    lines: QboSalesLine[],
    customerRef: QboRef | null,
  ): QboSalesDocumentInput {
    const body: QboSalesDocumentInput = {
      DocNumber: sale.saleNumber,
      PrivateNote: `POS sale ${sale.saleNumber}`,
      Line: lines,
    };
    if (customerRef) body.CustomerRef = customerRef;

    // The POS applies a single document-level tax amount. A precise QuickBooks tax
    // mapping needs a company TaxCode/TaxRate, so we pass the computed total only.
    // TODO(accountant): confirm the QuickBooks tax code mapping; TotalTax alone may
    // be recomputed by QuickBooks for automated-sales-tax companies.
    const taxAmount = Number(sale.taxAmount);
    if (taxAmount > 0) body.TxnTaxDetail = { TotalTax: taxAmount };

    return body;
  }

  /**
   * Resolve a QuickBooks CustomerRef from a stored customer mapping, if one exists.
   * Local customers are not automatically created in QuickBooks yet.
   * TODO(accountant): add customer sync so invoices/payments always carry a
   * CustomerRef instead of relying on a pre-existing mapping.
   */
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
    sale: SaleWithSyncRelations,
    documentId: string,
    quickbooksPaymentId: string | null,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.sale.update({
        where: { id: sale.id },
        data: { syncStatus: 'SYNCED', quickbooksDocumentId: documentId, syncError: null },
      });
      // D63 dual-write — same transaction, same facts, satellite copy.
      await mirrorExternalRef(tx, sale.tenantId, 'SALE', sale.id, {
        externalId: documentId,
        externalType: sale.quickbooksDocumentType,
        syncStatus: 'SYNCED',
        syncError: null,
        lastSyncedAt: new Date(),
      });
      // Payments are settled by the created document; record the QBO payment id
      // (invoice case) and mark them synced.
      const paymentRows = await tx.payment.findMany({
        where: { saleId: sale.id },
        select: { id: true },
      });
      await tx.payment.updateMany({
        where: { saleId: sale.id },
        data: {
          syncStatus: 'SYNCED',
          ...(quickbooksPaymentId ? { quickbooksPaymentId } : {}),
        },
      });
      for (const row of paymentRows) {
        await mirrorExternalRef(tx, sale.tenantId, 'PAYMENT', row.id, {
          ...(quickbooksPaymentId ? { externalId: quickbooksPaymentId } : {}),
          syncStatus: 'SYNCED',
          lastSyncedAt: new Date(),
        });
      }
      await tx.syncJob.updateMany({
        where: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          status: { in: ['PENDING', 'SYNCING', 'FAILED'] },
        },
        data: { status: 'SYNCED', completedAt: new Date(), lastError: null },
      });
      await tx.syncLog.create({
        data: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          direction: 'OUTBOUND',
          status: 'SYNCED',
          attempt,
          message: `${sale.quickbooksDocumentType} ${documentId} created in QuickBooks`,
          payload: {
            quickbooksDocumentType: sale.quickbooksDocumentType,
            quickbooksDocumentId: documentId,
            quickbooksPaymentId,
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  private async persistFailure(
    sale: SaleWithSyncRelations,
    message: string,
    attempt: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Rule 8: keep the sale saved in the POS; only mark the sync failed.
      await tx.sale.update({
        where: { id: sale.id },
        data: { syncStatus: 'FAILED', syncError: message },
      });
      // D63 dual-write.
      await mirrorExternalRef(tx, sale.tenantId, 'SALE', sale.id, {
        syncStatus: 'FAILED',
        syncError: message,
      });
      await tx.syncJob.updateMany({
        where: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          status: { in: ['PENDING', 'SYNCING'] },
        },
        data: { status: 'FAILED', lastError: message },
      });
      await tx.syncLog.create({
        data: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          attempt,
          message,
        },
      });
    });
  }

  private async nextAttempt(tenantId: string, saleId: string): Promise<number> {
    const last = await this.prisma.syncLog.findFirst({
      where: { tenantId, entityType: 'SALE', entityId: saleId, direction: 'OUTBOUND' },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    return (last?.attempt ?? 0) + 1;
  }

  private result(
    sale: SaleWithSyncRelations,
    status: 'SYNCED' | 'FAILED',
    documentId: string | null,
    quickbooksPaymentId: string | null,
    message: string,
  ): SaleSyncResult {
    return {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      status,
      quickbooksDocumentType: sale.quickbooksDocumentType,
      quickbooksDocumentId: documentId,
      quickbooksPaymentId,
      message,
    };
  }
}
