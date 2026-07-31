import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import {
  formatCurrency,
  ITEM_CONDITION_LABELS,
  QUOTATION_STATUS_LABELS,
  QuotationStatusCode,
  RETURN_REASON_LABELS,
  type ItemConditionCode,
  type ReturnReasonCode,
} from '@hardware-pos/shared';

import { customerAddressLine } from '../../common/customer-display';
import { PrismaService } from '../../prisma/prisma.service';
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

/** A returned or replacement line for the Exchange A4 template. */
export interface ExchangeLine {
  name: string;
  sku?: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
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

/** Sample hardware catalogue for template previews. Prices are LKR. */
const SAMPLE_ITEMS: { name: string; sku: string; unit: string; unitPrice: number; pack?: number }[] = [
  { name: 'Portland Cement 50kg', sku: 'CEM-50', unit: 'BAG', unitPrice: 2650 },
  { name: 'TMT Steel Bar 12mm (per length)', sku: 'STL-12', unit: 'PCS', unitPrice: 1980 },
  { name: 'PVC Pipe 2 inch — 6m', sku: 'PVC-2IN', unit: 'LENGTH', unitPrice: 1450 },
  { name: 'Weathershield Emulsion Paint 4L', sku: 'PNT-WS4', unit: 'CAN', unitPrice: 5400 },
  { name: 'Door Lock Set — Stainless', sku: 'LOCK-STD', unit: 'SET', unitPrice: 4850 },
  { name: 'Electrical Wire 1mm (per metre)', sku: 'WIRE-1MM', unit: 'M', unitPrice: 95, pack: 10 },
  { name: 'Angle Grinder 4 inch 720W', sku: 'GRND-4', unit: 'PCS', unitPrice: 9200 },
  { name: 'Safety Gloves — Nitrile', sku: 'GLOV-STD', unit: 'PAIR', unitPrice: 640 },
];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
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
      { label: 'Issue date', value: this.date(q.issueDate) },
      { label: 'Valid until', value: q.validUntil ? this.date(q.validUntil) : '—' },
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
      ...this.layout(docs),
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
    return tenant?.name ?? 'Hardware POS';
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
      name: it.productName,
      sku: it.sku,
      description: null,
      quantity: num(it.quantity),
      unitType: null,
      unitPrice: num(it.unitPrice),
      discountAmount: num(it.discountAmount),
      taxAmount: num(it.taxAmount),
      lineTotal: num(it.lineTotal),
    }));

    const paid = num(sale.paidAmount);
    const balance = num(sale.balanceAmount);
    const summary: A4SummaryLine[] = [{ label: 'Subtotal', value: formatCurrency(num(sale.subtotal)) }];
    if (num(sale.totalDiscount) > 0)
      summary.push({ label: 'Product discounts', value: `- ${formatCurrency(num(sale.totalDiscount))}`, muted: true });
    if (num(sale.orderDiscountAmount) > 0)
      summary.push({ label: 'Order discount', value: `- ${formatCurrency(num(sale.orderDiscountAmount))}`, muted: true });
    if (num(sale.taxAmount) > 0) summary.push({ label: 'Tax / VAT', value: formatCurrency(num(sale.taxAmount)) });
    summary.push({ label: 'Grand total', value: formatCurrency(num(sale.total)), strong: true });
    summary.push({ label: 'Paid', value: formatCurrency(paid) });
    if (balance > 0) summary.push({ label: 'Balance due', value: formatCurrency(balance) });

    const paymentMethods = sale.payments.map((p) => p.method).join(', ');
    const meta = [
      { label: 'Date', value: this.date((sale.completedAt ?? sale.createdAt).toISOString()) },
      { label: 'Payment', value: sale.paymentStatus },
      ...(paymentMethods ? [{ label: 'Method', value: paymentMethods }] : []),
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
      ...this.layout(docs),
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
        name: it.productNameSnapshot,
        sku: it.skuSnapshot,
        description: desc,
        quantity: num(it.returnQuantity),
        unitType: null,
        unitPrice: num(it.originalUnitPrice),
        discountAmount: 0,
        taxAmount: num(it.taxAdjustment),
        lineTotal: num(it.refundableAmount),
      };
    });

    const summary: A4SummaryLine[] = [{ label: 'Items refund', value: formatCurrency(num(ret.subtotal)) }];
    if (num(ret.productDiscountAdjustment) > 0)
      summary.push({ label: 'Product discount reversed', value: `- ${formatCurrency(num(ret.productDiscountAdjustment))}`, muted: true });
    if (num(ret.orderDiscountAdjustment) > 0)
      summary.push({ label: 'Order discount reversed', value: `- ${formatCurrency(num(ret.orderDiscountAdjustment))}`, muted: true });
    if (num(ret.taxAdjustment) > 0)
      summary.push({ label: 'Tax reversed', value: formatCurrency(num(ret.taxAdjustment)) });
    summary.push({ label: 'Total refund', value: formatCurrency(num(ret.refundTotal)), strong: true });
    if (ret.refundMethod) summary.push({ label: 'Refund method', value: ret.refundMethod });
    summary.push({ label: 'Refund status', value: ret.refundStatus });

    const meta = [
      { label: 'Date', value: this.date((ret.completedAt ?? ret.createdAt).toISOString()) },
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
      ...this.layout(docs),
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
  // Exchanges are not yet a first-class transaction in the POS. This renderer is
  // ready for that feature: pass the returned lines and the replacement lines and
  // it produces a combined A4 note showing the net amount due / to refund.

  buildExchangeDocument(
    tenantId: string,
    sellerName: string,
    exchangeNumber: string,
    returned: ExchangeLine[],
    replacements: ExchangeLine[],
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
      taxAmount: 0,
      lineTotal: sign * l.lineTotal,
    });
    const returnedTotal = returned.reduce((a, l) => a + l.lineTotal, 0);
    const replacementTotal = replacements.reduce((a, l) => a + l.lineTotal, 0);
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
      meta: [{ label: 'Date', value: this.date(new Date().toISOString()) }],
      columns: this.columns({ ...docs, showTaxColumn: false, showDiscountColumn: false }),
      rows: this.rows(lines, { ...docs, showTaxColumn: false, showDiscountColumn: false }),
      summary,
      footerText: docs.footerText,
      signatures: docs.signatureFields,
      ...this.layout(docs),
    };
  }

  // ── Template preview (sample data, for Settings → Documents) ──────────────

  /**
   * Render an A4 document with realistic sample data so admins can preview the
   * effect of template settings before/without a real transaction. `overrides`
   * lets the Settings UI preview UNSAVED document settings live.
   */
  previewHtml(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
  ): string {
    return renderA4Document(this.buildSampleDocument(tenantId, type, overrides, lineCount));
  }

  async previewPdf(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
  ): Promise<Buffer | null> {
    const docs = { ...this.settings.getSettings(tenantId).documents, ...overrides };
    return this.pdf.htmlToPdf(this.previewHtml(tenantId, type, overrides, lineCount), {
      showPageNumbers: docs.showPageNumbers,
      footerLabel: `${PREVIEW_TITLES[type]} SAMPLE`,
    });
  }

  buildSampleDocument(
    tenantId: string,
    type: PreviewDocumentType,
    overrides?: Partial<DocumentSettings>,
    lineCount = 6,
  ): A4Document {
    const docs: DocumentSettings = { ...this.settings.getSettings(tenantId).documents, ...overrides };
    const catalog = SAMPLE_ITEMS;
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
            { label: 'Issue date', value: this.date(new Date().toISOString()) },
            { label: 'Valid until', value: this.date(new Date(Date.now() + 14 * 864e5).toISOString()) },
            { label: 'Status', value: 'Sent' },
          ]
        : [
            { label: 'Date', value: this.date(new Date().toISOString()) },
            { label: 'Payment', value: type === 'return' ? 'Refunded' : 'Paid' },
            { label: 'Method', value: 'Cash' },
          ];

    return {
      seller: this.seller(docs, 'Hardware POS', 'Main Branch', 'No. 42, Galle Road, Colombo 03', '+94 11 234 5678'),
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
      ...this.layout(docs),
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
      name: docs.companyName ?? fallbackName ?? 'Hardware POS',
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
  private layout(docs: DocumentSettings): Pick<
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
      generatedAt: this.dateTime(new Date()),
    };
  }

  private dateTime(d: Date): string {
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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
      if (docs.showDiscountColumn) cells.push(l.discountAmount > 0 ? `- ${formatCurrency(l.discountAmount)}` : '—');
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

  private date(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}
