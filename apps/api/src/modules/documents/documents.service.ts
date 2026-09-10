import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import {
  ITEM_CONDITION_LABELS,
  QUOTATION_STATUS_LABELS,
  QuotationStatusCode,
  RETURN_REASON_LABELS,
  formatCurrency,
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  documentPaymentMethods,
  domainFor,
  paymentMethodLabel,
  safeTimeZone,
  saleLineLabel,
  saleLinePromotionNote,
  splitLineDiscounts,
  taxBreakdownForDocument,
  taxRateLabel,
  type ItemConditionCode,
  type ReturnReasonCode,
  type SampleCatalogueItem,
  type TaxableLine,
} from '@hardware-pos/shared';

import { customerAddressLine } from '../../common/customer-display';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProfileService } from '../platform/business-profile.service';
import { SettingsService } from '../settings/settings.service';
import { DocumentSettings } from '../settings/settings.interfaces';
import { QuotationDetail } from '../quotations/quotations.types';
import {
  A4Column,
  A4Document,
  A4Party,
  A4Row,
  A4Seller,
  A4SummaryLine,
  esc,
  renderA4Document,
} from './document-templates';
import { PdfService } from './pdf.service';

/** A line normalised for the A4 item table (both quotations and bills map here). */
interface DocLine {
  index: number;
  name: string;
  sku: string | null;
  description: string | null;
  quantity: number;
  unitType: string | null;
  unitPrice: number;
  discountAmount: number;
  /** How a per-unit discount was arrived at, e.g. "Rs. 100.00 × 3". Null otherwise. */
  discountNote: string | null;
  taxAmount: number;
  lineTotal: number;
}

const saleForBill = {
  items: true,
  payments: true,
  customer: true,
  branch: { select: { name: true, address: true, phone: true } },
  tenant: { select: { name: true } },
} satisfies Prisma.SaleInclude;

type SaleForBillRow = Prisma.SaleGetPayload<{ include: typeof saleForBill }>;

const returnForDoc = {
  items: true,
  originalSale: { select: { saleNumber: true } },
  customer: true,
  branch: { select: { name: true, address: true, phone: true } },
  tenant: { select: { name: true } },
  refundPayments: true,
} satisfies Prisma.ReturnInclude;

type ReturnForDocRow = Prisma.ReturnGetPayload<{ include: typeof returnForDoc }>;

/** D128 (`7.3`) — everything the exchange note needs, in one read. */
const exchangeForDoc = {
  return: { include: { items: true } },
  replacementSale: { include: { items: true } },
  tenant: { select: { name: true } },
} satisfies Prisma.ExchangeInclude;

/** A returned or replacement line for the Exchange A4 template. */
export interface ExchangeLine {
  name: string;
  sku?: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /**
   * `7.3` — the tax this line actually carried.
   *
   * Optional so the Settings sample preview, which has no tax to show, keeps
   * working unchanged. It was hardcoded to 0 for every line until Phase 7:
   * written before Phase 3 made tax per-line with snapshots, so an exchange
   * note showed no tax at all and did not tie to the money that moved.
   */
  taxAmount?: number;
}

/**
 * `7.3` — the real money either leg moved, when the caller knows it.
 *
 * Without this the note's net is a sum of DISPLAY lines, which is a
 * reconstruction of the money rather than the money. `Return.refundTotal` and
 * `Sale.total` are what the customer was actually handed and actually paid, so
 * a note built from them cannot disagree with the till.
 */
export interface ExchangeTotals {
  returnedTotal: number;
  replacementTotal: number;
}

/** Document types the Settings preview can render with sample data. */
export type PreviewDocumentType = 'quotation' | 'invoice' | 'return' | 'exchange';

const PREVIEW_TITLES: Record<PreviewDocumentType, string> = {
  quotation: 'Quotation',
  invoice: 'Invoice',
  return: 'Return / Refund',
  exchange: 'Exchange',
};

const PREVIEW_NUMBERS: Record<PreviewDocumentType, string> = {
  quotation: 'QT-2026-000124',
  invoice: 'INV-2026-004821',
  return: 'RET-2026-000317',
  exchange: 'EXC-2026-000042',
};

/**
 * D142 — the sample goods shown when a vertical declares none of its own.
 *
 * This slot used to hold a hardware catalogue — Portland cement, TMT steel bar
 * — and every workspace was previewed with it, so a clothing shop evaluating
 * the product saw a quotation for building materials on its own letterhead.
 * Those eight lines now live on the hardware descriptor, where they belong.
 *
 * What replaces them here is deliberately NEUTRAL. A fallback that named any
 * real trade would put that trade in front of every vertical which has not
 * declared its own — which is the exact defect being fixed, rebuilt one level
 * down. Dull filler that claims no trade is the honest answer for "we do not
 * know what this shop sells", and it still exercises what the preview is
 * actually for: column widths, wrapping, the discount and tax rows, and the
 * multiplied-quantity path.
 */
const NEUTRAL_SAMPLE_ITEMS: readonly SampleCatalogueItem[] = [
  { name: 'Standard Item 1', sku: 'ITEM-001', unit: 'PCS', unitPrice: 2500 },
  { name: 'Standard Item 2', sku: 'ITEM-002', unit: 'PCS', unitPrice: 1750 },
  { name: 'Standard Item 3', sku: 'ITEM-003', unit: 'BOX', unitPrice: 4200 },
  { name: 'Standard Item 4', sku: 'ITEM-004', unit: 'SET', unitPrice: 3100 },
  { name: 'Standard Item 5', sku: 'ITEM-005', unit: 'PCS', unitPrice: 950, pack: 10 },
  { name: 'Standard Item 6', sku: 'ITEM-006', unit: 'PKT', unitPrice: 1400 },
];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The taxable net of each line, for the shared allocation (D122, 3.12).
 *
 * Line net less its proportional share of the order discount — the same
 * quantity `computeReturnLine` derives, so the printed rows and a later refund
 * divide the recorded tax identically.
 */
function taxableLinesOf(
  items: readonly { lineTotal: Prisma.Decimal | number; taxRatePercent: Prisma.Decimal | number | null }[],
  subtotal: number,
  totalDiscount: number,
  orderDiscountAmount: number,
): TaxableLine[] {
  const discountedSubtotal = subtotal - totalDiscount;
  return items.map((it) => {
    const lineTotal = Number(it.lineTotal);
    const share =
      discountedSubtotal > 0 ? (orderDiscountAmount * lineTotal) / discountedSubtotal : 0;
    return {
      taxable: lineTotal - share,
      taxRatePercent: it.taxRatePercent === null ? null : Number(it.taxRatePercent),
    };
  });
}

/** Push the per-rate rows a document should print, if any (3.12). */
function pushTaxBreakdown(
  summary: A4SummaryLine[],
  lines: TaxableLine[],
  recordedTax: number,
): void {
  // Empty for a single-rate sale, a restaurant Sale (no lines) and any sale
  // predating 3.8 — each of which then renders exactly what it rendered before.
  for (const row of taxBreakdownForDocument(lines, recordedTax)) {
    summary.push({
      label: `Tax @ ${taxRateLabel(row.ratePercent)}`,
      value: formatCurrency(row.taxAmount),
      muted: true,
    });
  }
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
    /**
     * D142 — read to resolve which vertical's sample goods to preview.
     *
     * D28 forbids `ProductsService`, `SalesService` and `ReturnsService` from
     * injecting this, so that a business rule is never decided by a profile
     * branch inside a service. This is document PRESENTATION, decides nothing
     * about a transaction, and reads the registry rather than branching.
     */
    private readonly profiles: BusinessProfileService,
  ) {}

  /** Whether a server-side PDF engine (Puppeteer) is installed. */
  get pdfAvailable(): boolean {
    return this.pdf.available;
  }

  // ── Quotation A4 ─────────────────────────────────────────────

  buildQuotationDocument(tenantId: string, q: QuotationDetail, sellerName: string): A4Document {
    const docs = this.settings.getSettings(tenantId).documents;
    const lines: DocLine[] = q.items.map((it, i) => ({
      index: i + 1,
      name: it.productName,
      sku: it.sku,
      description: it.description,
      quantity: it.quantity,
      unitType: it.unitType,
      unitPrice: it.unitPrice,
      discountAmount: it.discountAmount,
      // Same treatment as the sale bill: a per-unit discount shows its
      // arithmetic, so the customer can check a figure that is larger than the
      // amount they were quoted per item.
      discountNote:
        it.discountBasis === 'UNIT' && it.discountValue != null
          ? `${formatCurrency(it.discountValue)} × ${it.quantity}`
          : null,
      taxAmount: it.taxAmount,
      lineTotal: it.lineTotal,
    }));

    const summary: A4SummaryLine[] = [{ label: 'Subtotal', value: formatCurrency(q.subtotal) }];
    if (q.productDiscountTotal > 0)
      summary.push({ label: 'Product discounts', value: `- ${formatCurrency(q.productDiscountTotal)}`, muted: true });
    if (q.quotationDiscountAmount > 0)
      summary.push({ label: 'Quotation discount', value: `- ${formatCurrency(q.quotationDiscountAmount)}`, muted: true });
    if (q.taxAmount > 0) summary.push({ label: 'Tax / VAT', value: formatCurrency(q.taxAmount) });
    summary.push({ label: 'Grand total', value: formatCurrency(q.grandTotal), strong: true });

    const meta = [
      { label: 'Issue date', value: this.date(q.issueDate, this.tz(tenantId)) },
      { label: 'Valid until', value: q.validUntil ? this.date(q.validUntil, this.tz(tenantId)) : '—' },
      { label: 'Status', value: QUOTATION_STATUS_LABELS[q.status] },
    ];

    return {
      seller: this.seller(docs, sellerName, q.branchName, q.branchAddress, q.branchPhone),
      title: 'Quotation',
      number: q.revisionLabel,
      statusBadge: QUOTATION_STATUS_LABELS[q.status],
      watermark: this.quotationWatermark(q.status, q.isExpired),
      meta,
      party: this.customerParty(q.customer, docs.showCustomerTaxNumber),
      columns: this.columns(docs),
      rows: this.rows(lines, docs),
      summary,
      notes: q.notes,
      terms: q.termsAndConditions,
      footerText: docs.footerText,
      signatures: docs.signatureFields,
      ...this.layout(docs, this.tz(tenantId)),
    };
  }

  async quotationHtml(tenantId: string, q: QuotationDetail): Promise<string> {
    const sellerName = await this.tenantName(tenantId);
    return renderA4Document(this.buildQuotationDocument(tenantId, q, sellerName));
  }

  async quotationPdf(tenantId: string, q: QuotationDetail): Promise<Buffer | null> {
    const docs = this.settings.getSettings(tenantId).documents;
    return this.pdf.htmlToPdf(await this.quotationHtml(tenantId, q), {
      showPageNumbers: docs.showPageNumbers,
      footerLabel: `Quotation ${q.revisionLabel}`,
    });
  }

  private async tenantName(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    // D141 — see `seller`: a missing name is not a reason to claim a trade.
    return tenant?.name ?? 'Your Business';
  }

  /**
   * D142 — the sample goods for this tenant's vertical.
   *
   * Read from the DOMAIN REGISTRY, never branched on here. `domainFor` is the
   * one place a business type may be compared (D56), and a `businessType ===`
   * in this service is precisely the if-chain the registry exists to end.
   *
   * A descriptor that declares nothing gets the neutral list rather than
   * another vertical's goods — see `NEUTRAL_SAMPLE_ITEMS`.
   */
  private async sampleItemsFor(tenantId: string): Promise<readonly SampleCatalogueItem[]> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    return domainFor(profile.businessType).catalogue.sampleItems ?? NEUTRAL_SAMPLE_ITEMS;
  }

  // ── Sale / bill A4 ───────────────────────────────────────────

  private async loadSale(tenantId: string, saleId: string): Promise<SaleForBillRow> {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: saleForBill,
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  buildSaleDocument(tenantId: string, sale: SaleForBillRow): A4Document {
    const docs = this.settings.getSettings(tenantId).documents;
    const num = (v: Prisma.Decimal | number | null) => (v == null ? 0 : Number(v));

    const lines: DocLine[] = sale.items.map((it, i) => ({
      index: i + 1,
      // D44/D120 — identify the SIZE that was sold, from the snapshots frozen at
      // sale time rather than the live variant. A return is argued from this
      // paper: printing only "Cotton Shirt" left a clerk no way to tell a
      // returned Medium from a Large.
      //
      // 2.12 moved this from a muted sub-line to the inline form the PO asked
      // for, and into `saleLineLabel` so all four renderers agree.
      name: saleLineLabel(it.productName, it.variantNameSnapshot),
      sku: it.variantSkuSnapshot ?? it.sku,
      // D123 (4.6) — a line at 0.00 with no explanation reads as a pricing
      // error. `description` renders as the muted sub-line beneath the name,
      // which is where 2.12 originally put the size. Snapshot, not the live
      // promotion, so a reprint says what the customer was actually given (D44).
      description: saleLinePromotionNote(it.promotionNameSnapshot),
      quantity: num(it.quantity),
      // D134d (`6.5`) — the A4 has carried a Unit column since quotations;
      // a sale line passed `null` into it. It now prints what the line was
      // sold in, so "0.75" reads as "0.75 kg".
      unitType: it.unitOfMeasureSnapshot,
      unitPrice: num(it.unitPrice),
      discountAmount: num(it.discountAmount),
      // Carried so the bill can show HOW a discount was arrived at; the amount
      // itself is already correct without it.
      discountNote:
        it.discountBasis === 'UNIT' && it.discountValue != null
          ? `${formatCurrency(num(it.discountValue))} × ${num(it.quantity)}`
          : null,
      taxAmount: num(it.taxAmount),
      lineTotal: num(it.lineTotal),
    }));

    const paid = num(sale.paidAmount);
    const balance = num(sale.balanceAmount);
    const summary: A4SummaryLine[] = [{ label: 'Subtotal', value: formatCurrency(num(sale.subtotal)) }];
    /*
     * D123 (4.6) — the two discount rows.
     *
     * 4.4 folded promotions into `totalDiscount` because the maths requires it,
     * which left this row printing "Product discounts" for a buy-two-get-one:
     * the right amount under the wrong name. `splitLineDiscounts` is the single
     * authority for the division, so all four renderers divide it identically.
     *
     * A sale with no promotions yields `{ manual: totalDiscount, promotional: 0 }`
     * and renders exactly as it always did.
     */
    const discountSplit = splitLineDiscounts(
      // `num` at the boundary: `shared` works in plain numbers so a browser can
      // import it, and Prisma hands back Decimals.
      sale.items.map((it) => ({ promotionDiscountAmount: num(it.promotionDiscountAmount) })),
      num(sale.totalDiscount),
    );
    if (discountSplit.manual > 0)
      summary.push({ label: 'Product discounts', value: `- ${formatCurrency(discountSplit.manual)}`, muted: true });
    if (discountSplit.promotional > 0)
      summary.push({ label: 'Promotions', value: `- ${formatCurrency(discountSplit.promotional)}`, muted: true });
    if (num(sale.orderDiscountAmount) > 0)
      summary.push({ label: 'Order discount', value: `- ${formatCurrency(num(sale.orderDiscountAmount))}`, muted: true });
    if (num(sale.taxAmount) > 0) {
      pushTaxBreakdown(
        summary,
        taxableLinesOf(
          sale.items,
          num(sale.subtotal),
          num(sale.totalDiscount),
          num(sale.orderDiscountAmount),
        ),
        num(sale.taxAmount),
      );
      summary.push({ label: 'Tax / VAT', value: formatCurrency(num(sale.taxAmount)) });
    }
    summary.push({ label: 'Grand total', value: formatCurrency(num(sale.total)), strong: true });
    summary.push({ label: 'Paid', value: formatCurrency(paid) });
    if (balance > 0) summary.push({ label: 'Balance due', value: formatCurrency(balance) });

    // "Credit" while a balance remains, the real method(s) once it is settled.
    const paymentMethods = documentPaymentMethods(sale.payments, balance);
    const meta = [
      { label: 'Date', value: this.date((sale.completedAt ?? sale.createdAt).toISOString(), this.tz(tenantId)) },
      { label: 'Payment', value: sale.paymentStatus },
      { label: 'Method', value: paymentMethods },
      ...(sale.paymentDueDate
        ? [{ label: 'Payment due', value: this.date(sale.paymentDueDate.toISOString(), this.tz(tenantId)) }]
        : []),
    ];

    return {
      seller: this.seller(docs, sale.tenant.name, sale.branch?.name ?? null, sale.branch?.address ?? null, sale.branch?.phone ?? null),
      title: 'Invoice',
      number: sale.saleNumber,
      statusBadge: sale.paymentStatus,
      watermark: sale.status === 'VOIDED' ? 'VOID' : balance > 0 ? 'UNPAID' : null,
      meta,
      party: this.customerParty(
        sale.customer
          ? {
              name: sale.customer.name,
              companyName: sale.customer.company,
              phone: sale.customer.phone,
              email: sale.customer.email,
              billingAddress: customerAddressLine(sale.customer),
              taxNumber: sale.customer.resaleNumber,
            }
          : null,
        docs.showCustomerTaxNumber,
      ),
      columns: this.columns(docs),
      rows: this.rows(lines, docs),
      summary,
      footerText: docs.footerText,
      billNote: docs.billNote || null,
      signatures: docs.signatureFields,
      ...this.layout(docs, this.tz(tenantId)),
    };
  }

  async saleHtml(tenantId: string, saleId: string): Promise<string> {
    const sale = await this.loadSale(tenantId, saleId);
    return renderA4Document(this.buildSaleDocument(tenantId, sale));
  }

  async salePdf(tenantId: string, saleId: string): Promise<Buffer | null> {
    const sale = await this.loadSale(tenantId, saleId);
    const docs = this.settings.getSettings(tenantId).documents;
    return this.pdf.htmlToPdf(renderA4Document(this.buildSaleDocument(tenantId, sale)), {
      showPageNumbers: docs.showPageNumbers,
      footerLabel: `Invoice ${sale.saleNumber}`,
    });
  }

  // ── Return / refund A4 ───────────────────────────────────────

  private async loadReturn(tenantId: string, returnId: string): Promise<ReturnForDocRow> {
    const ret = await this.prisma.return.findFirst({
      where: { id: returnId, tenantId },
      include: returnForDoc,
    });
    if (!ret) throw new NotFoundException('Return not found');
    return ret;
  }

  buildReturnDocument(tenantId: string, ret: ReturnForDocRow): A4Document {
    const docs = this.settings.getSettings(tenantId).documents;
    const num = (v: Prisma.Decimal | number | null) => (v == null ? 0 : Number(v));

    const lines: DocLine[] = ret.items.map((it, i) => {
      const reason = RETURN_REASON_LABELS[it.returnReason as ReturnReasonCode] ?? it.returnReason;
      const condition = ITEM_CONDITION_LABELS[it.itemCondition as ItemConditionCode] ?? it.itemCondition;
      const desc = [`${reason} · ${condition}`, it.note].filter(Boolean).join(' — ');
      return {
        index: i + 1,
        // 2.12 — returns carry the same snapshots since 1a.20, and a credit note
        // has exactly the same need as the receipt it reverses.
        name: saleLineLabel(it.productNameSnapshot, it.variantNameSnapshot),
        sku: it.variantSkuSnapshot ?? it.skuSnapshot,
        description: desc,
        quantity: num(it.returnQuantity),
        // D134d (`6.5`) — a credit note is a document as much as a receipt is,
        // which is why 3.8 put `taxRatePercent` on both tables too.
        unitType: it.unitOfMeasureSnapshot,
        unitPrice: num(it.originalUnitPrice),
        discountAmount: 0,
        discountNote: null,
        taxAmount: num(it.taxAdjustment),
        lineTotal: num(it.refundableAmount),
      };
    });

    const summary: A4SummaryLine[] = [{ label: 'Items refund', value: formatCurrency(num(ret.subtotal)) }];
    if (num(ret.productDiscountAdjustment) > 0)
      summary.push({ label: 'Product discount reversed', value: `- ${formatCurrency(num(ret.productDiscountAdjustment))}`, muted: true });
    if (num(ret.orderDiscountAdjustment) > 0)
      summary.push({ label: 'Order discount reversed', value: `- ${formatCurrency(num(ret.orderDiscountAdjustment))}`, muted: true });
    if (num(ret.taxAdjustment) > 0) {
      // 3.12 — a credit note shows WHICH rates were reversed, for the same
      // reason the receipt shows which were charged. `ReturnItem.taxRatePercent`
      // exists from 3.11, so the return groups exactly as the sale did.
      pushTaxBreakdown(
        summary,
        taxableLinesOf(
          ret.items.map((it) => ({
            lineTotal: num(it.originalLineSubtotal) - num(it.productDiscountAdjustment),
            taxRatePercent: it.taxRatePercent,
          })),
          num(ret.subtotal),
          num(ret.productDiscountAdjustment),
          num(ret.orderDiscountAdjustment),
        ),
        num(ret.taxAdjustment),
      );
      summary.push({ label: 'Tax reversed', value: formatCurrency(num(ret.taxAdjustment)) });
    }
    summary.push({ label: 'Total refund', value: formatCurrency(num(ret.refundTotal)), strong: true });
    // Labelled, not the raw enum: the return note was printing "BANK_TRANSFER"
    // at a customer while the invoice beside it said "Bank transfer".
    if (ret.refundMethod)
      summary.push({ label: 'Refund method', value: paymentMethodLabel(ret.refundMethod) });
    summary.push({ label: 'Refund status', value: ret.refundStatus });

    const meta = [
      { label: 'Date', value: this.date((ret.completedAt ?? ret.createdAt).toISOString(), this.tz(tenantId)) },
      { label: 'Original sale', value: ret.originalSale.saleNumber },
    ];

    return {
      seller: this.seller(docs, ret.tenant.name, ret.branch?.name ?? null, ret.branch?.address ?? null, ret.branch?.phone ?? null),
      title: 'Return / Refund',
      number: ret.returnNumber,
      statusBadge: ret.refundStatus,
      watermark: ret.refundStatus === 'FAILED' ? 'FAILED' : null,
      meta,
      party: this.customerParty(
        ret.customer
          ? {
              name: ret.customer.name,
              companyName: ret.customer.company,
              phone: ret.customer.phone,
              email: ret.customer.email,
              billingAddress: customerAddressLine(ret.customer),
              taxNumber: ret.customer.resaleNumber,
            }
          : null,
        docs.showCustomerTaxNumber,
      ),
      columns: this.columns(docs),
      rows: this.rows(lines, docs),
      summary,
      notes: ret.notes,
      footerText: docs.footerText,
      signatures: docs.signatureFields,
      ...this.layout(docs, this.tz(tenantId)),
    };
  }

  async returnHtml(tenantId: string, returnId: string): Promise<string> {
    const ret = await this.loadReturn(tenantId, returnId);
    return renderA4Document(this.buildReturnDocument(tenantId, ret));
  }

  async returnPdf(tenantId: string, returnId: string): Promise<Buffer | null> {
    const ret = await this.loadReturn(tenantId, returnId);
    const docs = this.settings.getSettings(tenantId).documents;
    return this.pdf.htmlToPdf(renderA4Document(this.buildReturnDocument(tenantId, ret)), {
      showPageNumbers: docs.showPageNumbers,
      footerLabel: `Return ${ret.returnNumber}`,
    });
  }

  // ── Exchange A4 (returned + replacement lines → net difference) ──────────────
  //
  // `7.4` — exchanges ARE a first-class transaction as of Phase 7 (D128). This
  // comment used to say they were not, and that the renderer was "ready for"
  // the feature; `exchangeHtml` below is the feature, and the Settings sample
  // preview is now the secondary caller rather than the only one.

  buildExchangeDocument(
    tenantId: string,
    sellerName: string,
    exchangeNumber: string,
    returned: ExchangeLine[],
    replacements: ExchangeLine[],
    totals?: ExchangeTotals,
  ): A4Document {
    const docs = this.settings.getSettings(tenantId).documents;
    const toDoc = (l: ExchangeLine, i: number, sign: number): DocLine => ({
      index: i + 1,
      name: `${sign < 0 ? 'Return: ' : 'New: '}${l.name}`,
      sku: l.sku ?? null,
      description: null,
      quantity: l.quantity,
      unitType: null,
      unitPrice: l.unitPrice,
      discountAmount: 0,
      discountNote: null,
      // `7.3` — the real tax, as a MAGNITUDE. Hardcoded 0 until Phase 7.
      //
      // Not negated on the returning side, unlike the line total: the shared
      // row builder renders any non-positive tax as an em dash, so a negative
      // would erase the figure rather than show it as a credit. The direction
      // of the line is already unambiguous from its negative total and the
      // "Return:" prefix on its name.
      taxAmount: l.taxAmount ?? 0,
      lineTotal: sign * l.lineTotal,
    });
    // Prefer the money that actually moved. Falling back to a sum of display
    // lines keeps the Settings sample preview working, where there is no
    // transaction to read totals from.
    const returnedTotal = totals?.returnedTotal ?? returned.reduce((a, l) => a + l.lineTotal, 0);
    const replacementTotal =
      totals?.replacementTotal ?? replacements.reduce((a, l) => a + l.lineTotal, 0);
    const net = Math.round((replacementTotal - returnedTotal) * 100) / 100;

    const lines = [
      ...returned.map((l, i) => toDoc(l, i, -1)),
      ...replacements.map((l, i) => toDoc(l, returned.length + i, 1)),
    ];
    const summary: A4SummaryLine[] = [
      { label: 'Returned value', value: `- ${formatCurrency(returnedTotal)}`, muted: true },
      { label: 'Replacement value', value: formatCurrency(replacementTotal) },
      {
        label: net >= 0 ? 'Balance due from customer' : 'Refund to customer',
        value: formatCurrency(Math.abs(net)),
        strong: true,
      },
    ];

    return {
      seller: this.seller(docs, sellerName, null, null, null),
      title: 'Exchange',
      number: exchangeNumber,
      meta: [{ label: 'Date', value: this.date(new Date().toISOString(), this.tz(tenantId)) }],
      // `7.3` — the TAX column now follows the tenant's setting, exactly as the
      // sale and return notes do. Forcing it off predates Phase 3 and hid the
      // one figure that makes the note tie to the money. The DISCOUNT column
      // stays off: an exchange line carries no per-line discount of its own,
      // because the price it is valued at already has one applied.
      columns: this.columns({ ...docs, showDiscountColumn: false }),
      rows: this.rows(lines, { ...docs, showDiscountColumn: false }),
      summary,
      footerText: docs.footerText,
      signatures: docs.signatureFields,
      ...this.layout(docs, this.tz(tenantId)),
    };
  }

  // ── Exchange A4 from REAL data (D128, `7.3`) ─────────────────────────────

  /**
   * Render the note for a real exchange.
   *
   * Until Phase 7 the only caller of `buildExchangeDocument` was the Settings
   * sample preview — D2's "a renderer with no transaction behind it". This is
   * the transaction behind it.
   *
   * The totals come from `Return.refundTotal` and `Sale.total`: what the
   * customer was actually handed and actually paid. A note built from a sum of
   * display lines would be a reconstruction of the money, not the money.
   */
  async exchangeHtml(tenantId: string, exchangeId: string): Promise<string> {
    const row = await this.prisma.exchange.findFirst({
      where: { id: exchangeId, tenantId },
      include: exchangeForDoc,
    });
    if (!row) throw new NotFoundException('Exchange not found');

    const num = (v: Prisma.Decimal | number | null) => (v == null ? 0 : Number(v));

    const returned: ExchangeLine[] = row.return.items.map((it) => ({
      // 2.12 — the size has to survive onto every document, not most of them.
      name: saleLineLabel(it.productNameSnapshot, it.variantNameSnapshot),
      sku: it.variantSkuSnapshot ?? it.skuSnapshot,
      quantity: num(it.returnQuantity),
      unitPrice: num(it.originalUnitPrice),
      lineTotal: num(it.refundableAmount),
      // 3.11 — the tax this line actually paid, from its snapshot, rather than
      // a rate recomputed today.
      taxAmount: num(it.taxAdjustment),
    }));

    // An exchange whose replacement leg never completed still prints: the
    // customer has been refunded and is entitled to a note saying so. D128 —
    // unresolved is its own state, and refusing to render would leave the
    // operator with nothing to hand over.
    const replacements: ExchangeLine[] = (row.replacementSale?.items ?? []).map((it) => ({
      // A SaleItem names its product directly; only the VARIANT is snapshotted
      // (D44). The return side uses productNameSnapshot because a ReturnItem
      // snapshots both.
      name: saleLineLabel(it.productName, it.variantNameSnapshot),
      sku: it.variantSkuSnapshot ?? it.sku,
      quantity: num(it.quantity),
      unitPrice: num(it.unitPrice),
      lineTotal: num(it.lineTotal),
      taxAmount: num(it.taxAmount),
    }));

    return renderA4Document(
      this.buildExchangeDocument(
        tenantId,
        row.tenant.name,
        row.exchangeNumber,
        returned,
        replacements,
        {
          returnedTotal: num(row.return.refundTotal),
          replacementTotal: num(row.replacementSale?.total ?? 0),
        },
      ),
    );
  }

  // ── Template preview (sample data, for Settings → Documents) ──────────────

  /**
   * Render an A4 document with realistic sample data so admins can preview the
   * effect of template settings before/without a real transaction. `overrides`
   * lets the Settings UI preview UNSAVED document settings live.
   */
  /**
   * D141 — async so the letterhead can be the tenant's OWN name.
   *
   * The preview used to fall back to the literal 'Hardware POS' when a
   * workspace had not filled its business name in, which is every workspace
   * that has not been through Settings yet. A retail owner opening Preview
   * saw a quotation from a hardware shop and reasonably read it as a bug.
   *
   * Swapping one hard-coded vertical for another would only move the problem
   * to whoever is not that vertical. The tenant's registered name is the one
   * answer that is right for all of them, and it is what the operator would
   * have typed anyway.
   */
  async previewHtml(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
  ): Promise<string> {
    const fallbackName = await this.tenantName(tenantId);
    return renderA4Document(
      this.buildSampleDocument(
        tenantId,
        type,
        overrides,
        lineCount,
        fallbackName,
        await this.sampleItemsFor(tenantId),
      ),
    );
  }

  async previewPdf(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
  ): Promise<Buffer | null> {
    const docs = { ...this.settings.getSettings(tenantId).documents, ...overrides };
    return this.pdf.htmlToPdf(await this.previewHtml(tenantId, type, overrides, lineCount), {
      showPageNumbers: docs.showPageNumbers,
      footerLabel: `${PREVIEW_TITLES[type]} SAMPLE`,
    });
  }

  buildSampleDocument(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
    /**
     * D141 — the name to show when the workspace has set none. Passed in
     * rather than looked up here, because this builder is synchronous and
     * every one of its other inputs is already resolved by its caller.
     */
    fallbackName = 'Your Business',
    /**
     * D142 — the goods to illustrate the sample with, resolved by the caller
     * from the tenant's own vertical. Passed in for the same reason
     * `fallbackName` is: this builder is synchronous and every other input
     * it takes is already resolved.
     */
    sampleItems: readonly SampleCatalogueItem[] = NEUTRAL_SAMPLE_ITEMS,
  ): A4Document {
    const docs: DocumentSettings = { ...this.settings.getSettings(tenantId).documents, ...overrides };
    const catalog = sampleItems;
    const lines: DocLine[] = Array.from({ length: Math.max(1, lineCount) }, (_, i) => {
      const s = catalog[i % catalog.length];
      const quantity = ((i % 4) + 1) * (s.pack ?? 1);
      const lineSub = round2(s.unitPrice * quantity);
      const discountAmount = i % 3 === 0 ? round2(lineSub * 0.05) : 0;
      const taxAmount = docs.showTaxColumn ? round2((lineSub - discountAmount) * 0.15) : 0;
      return {
        index: i + 1,
        name: s.name,
        sku: s.sku,
        description: null,
        quantity,
        unitType: s.unit,
        unitPrice: s.unitPrice,
        discountAmount,
        discountNote: null,
        taxAmount,
        lineTotal: round2(lineSub - discountAmount + taxAmount),
      };
    });

    const subtotal = round2(lines.reduce((a, l) => a + l.unitPrice * l.quantity, 0));
    const discountTotal = round2(lines.reduce((a, l) => a + l.discountAmount, 0));
    const taxTotal = round2(lines.reduce((a, l) => a + l.taxAmount, 0));
    const grand = round2(subtotal - discountTotal + taxTotal);

    const summary: A4SummaryLine[] = [{ label: 'Subtotal', value: formatCurrency(subtotal) }];
    if (discountTotal > 0)
      summary.push({ label: 'Product discounts', value: `- ${formatCurrency(discountTotal)}`, muted: true });
    if (taxTotal > 0) summary.push({ label: 'Tax / VAT (15%)', value: formatCurrency(taxTotal) });
    summary.push({ label: 'Grand total', value: formatCurrency(grand), strong: true });
    if (type === 'invoice') {
      summary.push({ label: 'Paid', value: formatCurrency(grand) });
      summary.push({ label: 'Balance due', value: formatCurrency(0) });
    }

    const meta =
      type === 'quotation'
        ? [
            { label: 'Issue date', value: this.date(new Date().toISOString(), this.tz(tenantId)) },
            { label: 'Valid until', value: this.date(new Date(Date.now() + 14 * 864e5).toISOString(), this.tz(tenantId)) },
            { label: 'Status', value: 'Sent' },
          ]
        : [
            { label: 'Date', value: this.date(new Date().toISOString(), this.tz(tenantId)) },
            { label: 'Payment', value: type === 'return' ? 'Refunded' : 'Paid' },
            { label: 'Method', value: 'Cash' },
          ];

    return {
      seller: this.seller(
        docs,
        fallbackName,
        'Main Branch',
        'No. 42, Galle Road, Colombo 03',
        '+94 11 234 5678',
      ),
      title: PREVIEW_TITLES[type],
      number: PREVIEW_NUMBERS[type],
      statusBadge: type === 'quotation' ? 'Sent' : type === 'return' ? 'Refunded' : 'Paid',
      watermark: null,
      meta,
      party: this.customerParty(
        {
          name: 'Saman Perera',
          companyName: 'Perera Constructions (Pvt) Ltd',
          phone: '+94 77 123 4567',
          email: 'saman@pereraconstructions.lk',
          billingAddress: 'No. 128, Kandy Road, Kadawatha',
          taxNumber: '134567890-7000',
        },
        docs.showCustomerTaxNumber,
      ),
      columns: this.columns(docs),
      rows: this.rows(lines, docs),
      summary,
      notes: type === 'quotation' ? 'Delivery within 5 working days of confirmed order.' : null,
      terms: type === 'quotation' ? 'This quotation is valid until the date shown above. Prices subject to stock availability.' : null,
      footerText: docs.footerText,
      billNote: type === 'invoice' ? docs.billNote || null : null,
      signatures: docs.signatureFields,
      ...this.layout(docs, this.tz(tenantId)),
    };
  }

  // ── Shared building blocks ───────────────────────────────────

  private seller(
    docs: DocumentSettings,
    fallbackName: string,
    branchName: string | null,
    branchAddress: string | null,
    branchPhone: string | null,
  ): A4Seller {
    return {
      // D141 — neutral, not a vertical. This is only reached when a
      // workspace has no business name AND no tenant name, so naming any one
      // trade here puts somebody else's shop on the operator's letterhead.
      name: docs.companyName ?? fallbackName ?? 'Your Business',
      addressLine: docs.addressLine ?? branchAddress ?? (branchName ? `Branch: ${branchName}` : null),
      phone: docs.phone ?? branchPhone ?? null,
      email: docs.email ?? null,
      taxNumber: docs.taxNumber ?? null,
      logoUrl: docs.logoUrl ?? null,
    };
  }

  /**
   * Configurable letterhead/layout fields shared by every A4 document, spread
   * into each builder's return value so all document types honour the admin's
   * branding + layout settings from one place.
   */
  private layout(docs: DocumentSettings, tz: string): Pick<
    A4Document,
    | 'accentColor'
    | 'logoAlignment'
    | 'logoSize'
    | 'marginStyle'
    | 'signatureImageUrl'
    | 'stampImageUrl'
    | 'showPageNumbers'
    | 'generatedAt'
  > {
    return {
      accentColor: docs.accentColor,
      logoAlignment: docs.logoAlignment,
      logoSize: docs.logoSize,
      marginStyle: docs.marginStyle,
      signatureImageUrl: docs.signatureUrl,
      stampImageUrl: docs.stampUrl,
      showPageNumbers: docs.showPageNumbers,
      generatedAt: this.dateTime(new Date(), tz),
    };
  }

  private dateTime(d: Date, tz: string): string {
    return formatDateTimeInTimeZone(d, tz);
  }

  private customerParty(
    customer:
      | {
          name: string;
          companyName: string | null;
          phone: string | null;
          email: string | null;
          billingAddress: string | null;
          taxNumber: string | null;
        }
      | null,
    showTaxNumber = true,
  ): A4Party {
    if (!customer) return { label: 'Bill to', name: 'Walk-in customer' };
    return {
      label: 'Bill to',
      name: customer.name,
      company: customer.companyName,
      phone: customer.phone,
      email: customer.email,
      address: customer.billingAddress,
      taxNumber: showTaxNumber ? customer.taxNumber : null,
    };
  }

  private columns(docs: DocumentSettings): A4Column[] {
    const cols: A4Column[] = [{ label: '#', align: 'left', width: '28px' }, { label: 'Product', align: 'left' }];
    if (docs.showSku) cols.push({ label: 'SKU', align: 'left' });
    cols.push({ label: 'Qty', align: 'right' });
    cols.push({ label: 'Unit', align: 'left' });
    cols.push({ label: 'Unit price', align: 'right' });
    if (docs.showDiscountColumn) cols.push({ label: 'Discount', align: 'right' });
    if (docs.showTaxColumn) cols.push({ label: 'Tax', align: 'right' });
    cols.push({ label: 'Line total', align: 'right' });
    return cols;
  }

  private rows(lines: DocLine[], docs: DocumentSettings): A4Row[] {
    return lines.map((l) => {
      const name = l.description
        ? `${esc(l.name)}<div style="color:#94a3b8;font-size:10.5px">${esc(l.description)}</div>`
        : esc(l.name);
      const cells: string[] = [String(l.index), name];
      if (docs.showSku) cells.push(esc(l.sku ?? '—'));
      cells.push(this.qty(l.quantity));
      cells.push(esc(l.unitType ?? '—'));
      cells.push(formatCurrency(l.unitPrice));
      if (docs.showDiscountColumn) {
        // The whole-line string is left exactly as it was: every past invoice is
        // reprintable from here, and changing it would rewrite their appearance.
        cells.push(
          l.discountAmount > 0
            ? `- ${formatCurrency(l.discountAmount)}${l.discountNote ? ` (${l.discountNote})` : ''}`
            : '—',
        );
      }
      if (docs.showTaxColumn) cells.push(l.taxAmount > 0 ? formatCurrency(l.taxAmount) : '—');
      cells.push(formatCurrency(l.lineTotal));
      return { cells };
    });
  }

  private quotationWatermark(status: QuotationStatusCode, isExpired: boolean): string | null {
    if (status === 'CANCELLED') return 'CANCELLED';
    if (status === 'CONVERTED_TO_SALE') return 'CONVERTED';
    if (isExpired) return 'EXPIRED';
    if (status === 'DRAFT') return 'DRAFT';
    return null;
  }

  private qty(n: number): string {
    return Number.isInteger(n) ? String(n) : String(n);
  }

  private date(iso: string, tz: string): string {
    return formatDateInTimeZone(new Date(iso), tz);
  }

  /**
   * The zone printed documents are rendered in. Deliberately the SHOP's zone and
   * not the requester's: an invoice is a business record, so a reprint — or the
   * customer's emailed copy opened in another country — must carry the same date
   * as the original. On-screen datetimes use the viewer's own zone instead.
   */
  private tz(tenantId: string): string {
    return safeTimeZone(this.settings.getSettings(tenantId).timezone);
  }
}
