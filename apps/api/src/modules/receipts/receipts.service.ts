import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrintJob, Receipt } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { safeTimeZone } from '@hardware-pos/shared';

import { SettingsService } from '../settings/settings.service';
import { ReceiptsRepository, SaleForReceipt } from './receipts.repository';
import {
  CustomerReceiptData,
  formatReceiptDateTime,
  renderCustomerReceipt,
} from './receipt-templates';
import { QueryPrintJobsDto } from './dto/query-print-jobs.dto';

export interface CustomerReceiptResult {
  receiptNumber: string;
  printJob: PrintJob;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly receiptsRepository: ReceiptsRepository,
    private readonly settingsService: SettingsService,
  ) {}

  // ── generation ─────────────────────────────────────────────────────────────

  /** Generate the customer receipt for a completed sale. */
  async generateCustomer(
    tenantId: string,
    saleId: string,
    userId: string | null,
  ): Promise<CustomerReceiptResult> {
    const sale = await this.loadCompletedSale(tenantId, saleId);
    const settings = this.settingsService.getSettings(tenantId);

    const receiptData = this.toCustomerReceiptData(
      sale,
      settings.currency,
      settings.receiptFooter,
      safeTimeZone(settings.timezone),
    );
    const receipt = await this.receiptsRepository.upsertReceipt(
      sale.id,
      `RCP-${sale.saleNumber}`,
      this.toReceiptContent(receiptData),
    );

    const printJob = await this.receiptsRepository.createPrintJob({
      tenantId,
      saleId: sale.id,
      receiptId: receipt.id,
      type: 'CUSTOMER_RECEIPT',
      html: renderCustomerReceipt(receiptData),
      createdByUserId: userId,
    });

    return { receiptNumber: receipt.receiptNumber, printJob };
  }

  // ── print jobs ─────────────────────────────────────────────────────────────

  async listPrintJobs(tenantId: string, query: QueryPrintJobsDto): Promise<Paginated<PrintJob>> {
    const [items, total] = await this.receiptsRepository.listPrintJobs(
      tenantId,
      { saleId: query.saleId, status: query.status, type: query.type },
      query.skip,
      query.take,
    );
    return paginate(items, total, query.page, query.pageSize);
  }

  async markPrinted(tenantId: string, id: string): Promise<PrintJob> {
    const job = await this.receiptsRepository.findPrintJob(tenantId, id);
    if (!job) {
      throw new NotFoundException(`Print job ${id} not found`);
    }
    return this.receiptsRepository.markPrinted(job.id);
  }

  // ── receipt reads ────────────────────────────────────────────────────────────

  async getReceiptBySale(tenantId: string, saleId: string): Promise<Receipt> {
    const receipt = await this.receiptsRepository.findReceiptBySale(tenantId, saleId);
    if (!receipt) {
      throw new NotFoundException(`No receipt for sale ${saleId}`);
    }
    return receipt;
  }

  async getReceiptById(tenantId: string, id: string): Promise<Receipt> {
    const receipt = await this.receiptsRepository.findReceiptById(tenantId, id);
    if (!receipt) {
      throw new NotFoundException(`Receipt ${id} not found`);
    }
    return receipt;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async loadCompletedSale(tenantId: string, saleId: string): Promise<SaleForReceipt> {
    const sale = await this.receiptsRepository.findSaleForReceipt(tenantId, saleId);
    if (!sale) {
      throw new NotFoundException(`Sale ${saleId} not found`);
    }
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException('Receipts are only available for completed sales');
    }
    return sale;
  }

  private toCustomerReceiptData(
    sale: SaleForReceipt,
    currency: string,
    footer: string,
    tz: string,
  ): CustomerReceiptData {
    return {
      storeName: sale.tenant.name,
      saleNumber: sale.saleNumber,
      dateTime: formatReceiptDateTime(sale.completedAt ?? sale.createdAt, tz),
      documentType: sale.quickbooksDocumentType,
      customerName: sale.customer?.name ?? null,
      currency,
      items: sale.items.map((it) => ({
        name: it.productName,
        sku: it.sku,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        discountAmount: Number(it.discountAmount),
        discountBasis: it.discountBasis,
        discountValue: it.discountValue != null ? Number(it.discountValue) : null,
        lineTotal: Number(it.lineTotal),
      })),
      subtotal: Number(sale.subtotal),
      totalDiscount: Number(sale.totalDiscount),
      orderDiscount: Number(sale.orderDiscountAmount),
      taxAmount: Number(sale.taxAmount),
      total: Number(sale.total),
      paidAmount: Number(sale.paidAmount),
      balanceAmount: Number(sale.balanceAmount),
      paymentStatus: sale.paymentStatus,
      payments: sale.payments.map((p) => ({ method: p.method, amount: Number(p.amount) })),
      footer,
    };
  }

  private toReceiptContent(data: CustomerReceiptData): Prisma.InputJsonValue {
    return { ...data } as unknown as Prisma.InputJsonValue;
  }
}
