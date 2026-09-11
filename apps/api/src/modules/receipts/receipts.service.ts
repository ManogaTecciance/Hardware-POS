import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrintJob, Receipt } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { safeTimeZone } from '@hardware-pos/shared';

import { SettingsService } from '../settings/settings.service';
import {
  customerDocumentLabel,
  resolveCustomerDocumentKind,
} from '../sales/customer-document';
import { ReceiptsRepository, SaleForReceipt } from './receipts.repository';
import {
  CustomerReceiptData,
  formatReceiptDateTime,
  renderCustomerReceipt,
} from './receipt-templates';
import { QueryPrintJobsDto } from './dto/query-print-jobs.dto';
import {
  saleLineLabel,
  saleLineQuantity,
  saleLinePromotionNote,
  splitLineDiscounts,
  taxBreakdownForDocument,
} from '@hardware-pos/shared';

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

  /**
   * Generate the customer receipt for a completed sale.
   *
   * D162 — `amountTendered` is passed through to the renderer and
   * nowhere else. It does not touch `paidAmount`, `balanceAmount` or the
   * `Payment` row: the sale really was settled for its total, and the
   * difference was handed straight back over the counter.
   */
  async generateCustomer(
    tenantId: string,
    saleId: string,
    userId: string | null,
    amountTendered?: number,
  ): Promise<CustomerReceiptResult> {
    const sale = await this.loadCompletedSale(tenantId, saleId);
    const settings = this.settingsService.getSettings(tenantId);

    /*
     * D165 — a reprint keeps the tender the first print recorded.
     *
     * The till sends `amountTendered` once, at the counter. `Receipt.content`
     * is a JSON column and the receipt data is spread into it, so that first
     * print DID store the number — and then the first reprint destroyed it,
     * because `upsertReceipt` overwrites `content` and a reprint has no
     * tender of its own to put back.
     *
     * So the stored value is carried forward when the caller supplies none.
     * A reprint from Sales now shows what the customer actually handed over,
     * with no schema change: the number was already on disk, and the bug was
     * that we were erasing it.
     *
     * A supplied tender always WINS, so the till stays the authority for the
     * sale it just took.
     */
    const tender = amountTendered ?? (await this.storedTender(tenantId, saleId));

    const receiptData = this.toCustomerReceiptData(
      sale,
      settings.currency,
      settings.receiptFooter,
      safeTimeZone(settings.timezone),
      tender,
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

  /**
   * A sale that money actually moved through, whatever happened to it after.
   *
   * Until 2026-09-08 this demanded `COMPLETED`, which put an arbitrary cliff
   * at a full return: refund 99% of a sale and its status stayed `COMPLETED`
   * and the receipt reprinted; refund the last 1% and the status became
   * `REFUNDED` and the receipt was gone. **And every exchange crossed it** —
   * a size swap returns the whole sale by definition (D130), so after any
   * exchange the original receipt became unreachable.
   *
   * The sale happened; the receipt is the record of it, and a customer or an
   * auditor asking for the receipt of a later-returned sale is ordinary. So
   * `REFUNDED` and `VOIDED` both reprint — a voided one carrying a stamp, so
   * the paper trail cannot be reused as proof of a live sale.
   *
   * `DRAFT` is still refused, and that is not the same kind of rule: a held
   * basket has taken no money, so there is no transaction to document. The
   * till also no longer offers the button there.
   */
  private async loadCompletedSale(tenantId: string, saleId: string): Promise<SaleForReceipt> {
    const sale = await this.receiptsRepository.findSaleForReceipt(tenantId, saleId);
    if (!sale) {
      throw new NotFoundException(`Sale ${saleId} not found`);
    }
    if (sale.status === 'DRAFT') {
      throw new BadRequestException(
        'This sale is still on hold and has taken no payment, so it has no receipt yet.',
      );
    }
    return sale;
  }

  /**
   * D165 — the tender a previous print recorded, or undefined.
   *
   * Read defensively: `content` is JSON written by this service, but it is
   * still a column anything could have put a shape into, and a receipt that
   * cannot be re-rendered is worse than one missing a row.
   */
  private async storedTender(tenantId: string, saleId: string): Promise<number | undefined> {
    const existing = await this.receiptsRepository.findReceiptBySale(tenantId, saleId);
    const content = existing?.content as { amountTendered?: unknown } | null;
    const stored = content?.amountTendered;
    return typeof stored === 'number' && Number.isFinite(stored) ? stored : undefined;
  }

  private toCustomerReceiptData(
    sale: SaleForReceipt,
    currency: string,
    footer: string,
    tz: string,
    amountTendered?: number,
  ): CustomerReceiptData {
    return {
      // D162 — spread into the stored `Receipt.content` too (it is a JSON
      // column, so no migration), which means the ORIGINAL receipt keeps a
      // record of the tender. A reprint re-renders without it, exactly as
      // it does today.
      ...(amountTendered != null ? { amountTendered } : {}),
      storeName: sale.tenant.name,
      saleNumber: sale.saleNumber,
      dateTime: formatReceiptDateTime(sale.completedAt ?? sale.createdAt, tz),
      // External-integration metadata when the tenant has an accounting provider —
      // unchanged, so a QuickBooks receipt still prints exactly `SALES_RECEIPT` or
      // `INVOICE`. Otherwise the LOCAL document kind, derived from payment status, so
      // a tenant with no accounting provider gets a real "Receipt"/"Invoice" label
      // instead of a blank space where a badge used to be.
      documentType:
        sale.quickbooksDocumentType ??
        customerDocumentLabel(resolveCustomerDocumentKind(sale.paymentStatus)),
      customerName: sale.customer?.name ?? null,
      // Stamped, not merely recorded. A voided sale reprints so the paper
      // trail survives; the stamp is what stops the reprint being reused as
      // proof of a live sale.
      voided: sale.status === 'VOIDED',
      currency,
      items: sale.items.map((it) => ({
        // D120 (2.12) — the size, on the paper a customer walks out with. This
        // renderer was missed by 1c.7, so the same sale printed with the variant
        // from the A4 endpoint and without it from here.
        name: saleLineLabel(it.productName, it.variantNameSnapshot),
        // D123 (4.6) — the offer, on the paper the customer walks out with. A
        // free line printed at 0.00 with no reason reads as a pricing error.
        promotionNote: saleLinePromotionNote(it.promotionNameSnapshot),
        sku: it.variantSkuSnapshot ?? it.sku,
        // D134d (`6.5`) — through the shared formatter, like `saleLineLabel`
        // three lines up and for the same reason: four renderers print a sale
        // line, and 1c.7 fixed two of them.
        quantity: saleLineQuantity(it.quantity.toString(), it.unitOfMeasureSnapshot),
        unitPrice: Number(it.unitPrice),
        discountAmount: Number(it.discountAmount),
        discountBasis: it.discountBasis,
        discountValue: it.discountValue != null ? Number(it.discountValue) : null,
        lineTotal: Number(it.lineTotal),
      })),
      subtotal: Number(sale.subtotal),
      totalDiscount: Number(sale.totalDiscount),
      // D123 (4.6) — the SHARED split, so this receipt and the A4 divide the
      // same figure the same way.
      promotionDiscount: splitLineDiscounts(
        sale.items.map((it) => ({ promotionDiscountAmount: Number(it.promotionDiscountAmount) })),
        Number(sale.totalDiscount),
      ).promotional,
      orderDiscount: Number(sale.orderDiscountAmount),
      taxAmount: Number(sale.taxAmount),
      // D122 (3.12) — the SHARED allocation, so the printed rows and a later
      // refund divide the recorded tax the same way. Empty for a single-rate
      // sale, which is every tenant today.
      taxBreakdown: taxBreakdownForDocument(
        (() => {
          const discountedSubtotal = Number(sale.subtotal) - Number(sale.totalDiscount);
          return sale.items.map((it) => {
            const lineTotal = Number(it.lineTotal);
            const share =
              discountedSubtotal > 0
                ? (Number(sale.orderDiscountAmount) * lineTotal) / discountedSubtotal
                : 0;
            return {
              taxable: lineTotal - share,
              taxRatePercent: it.taxRatePercent === null ? null : Number(it.taxRatePercent),
            };
          });
        })(),
        Number(sale.taxAmount),
      ),
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
