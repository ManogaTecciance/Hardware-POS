import { Injectable } from '@nestjs/common';
import {
  CURRENCY_CODE,
  CURRENCY_LOCALE,
  CURRENCY_SYMBOL,
  dayInTimeZone,
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  safeTimeZone,
} from '@hardware-pos/shared';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { QuerySalesReportDto } from './dto/query-sales-report.dto';
import { SettingsService } from '../settings/settings.service';
import { SalesRepository } from './sales.repository';
import { toSaleListItem } from './sales.service';
import { SaleListItem } from './sales.types';

/** Hard cap so a runaway range can't build an unbounded file in memory. */
const MAX_REPORT_ROWS = 5000;

export interface GeneratedReport {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

interface ReportSummary {
  transactions: number;
  gross: number;
  discounts: number;
  tax: number;
  paid: number;
  outstanding: number;
}

interface ReportData {
  rows: SaleListItem[];
  summary: ReportSummary;
  totalMatching: number;
  /** Shop timezone every date in this report is rendered in. */
  timezone: string;
  generatedAt: Date;
  dateFrom?: Date;
  dateTo?: Date;
  filters: string[];
}

const money = new Intl.NumberFormat(CURRENCY_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtMoney(n: number): string {
  return money.format(n);
}

/**
 * The report is a document, so its dates read in the SHOP's timezone rather than
 * the server's or the requester's — the same figures must describe the same days
 * whoever exports them.
 */
function fmtDateTime(d: Date, tz: string): string {
  return formatDateTimeInTimeZone(d, tz, CURRENCY_LOCALE);
}

function fmtDate(d: Date, tz: string): string {
  return formatDateInTimeZone(d, tz, CURRENCY_LOCALE);
}

@Injectable()
export class SalesReportService {
  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly settings: SettingsService,
  ) {}

  async generate(tenantId: string, query: QuerySalesReportDto): Promise<GeneratedReport> {
    const data = await this.buildData(tenantId, query);
    // The shop's day, not UTC's — a report pulled at 02:00 Colombo would
    // otherwise be filed under the previous day while its header says today.
    const stamp = dayInTimeZone(data.generatedAt, data.timezone);
    if (query.format === 'xlsx') {
      return {
        buffer: await this.renderXlsx(data),
        filename: `sales-report-${stamp}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    return {
      buffer: await this.renderPdf(data),
      filename: `sales-report-${stamp}.pdf`,
      contentType: 'application/pdf',
    };
  }

  private async buildData(tenantId: string, query: QuerySalesReportDto): Promise<ReportData> {
    const [rowsRaw, totalMatching] = await this.salesRepository.findManyByTenant(
      tenantId,
      {
        syncStatus: query.syncStatus,
        paymentStatus: query.paymentStatus,
        search: query.search?.trim() || undefined,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        // Exported from a filtered screen, the report must cover the same sales
        // the screen was showing — an overdue export that quietly widened to
        // every sale would be worse than no export.
        overdueAsOf: query.overdue === 'true' ? new Date() : undefined,
      },
      0,
      MAX_REPORT_ROWS,
    );
    const rows = rowsRaw.map(toSaleListItem);

    const summary = rows.reduce<ReportSummary>(
      (acc, r) => ({
        transactions: acc.transactions + 1,
        gross: acc.gross + r.total,
        discounts: acc.discounts + r.totalDiscount + r.orderDiscountAmount,
        tax: acc.tax + r.taxAmount,
        paid: acc.paid + r.paidAmount,
        outstanding: acc.outstanding + r.balanceAmount,
      }),
      { transactions: 0, gross: 0, discounts: 0, tax: 0, paid: 0, outstanding: 0 },
    );

    const filters: string[] = [];
    if (query.paymentStatus) filters.push(`Payment: ${query.paymentStatus}`);
    if (query.syncStatus) filters.push(`Sync: ${query.syncStatus}`);
    if (query.search?.trim()) filters.push(`Search: "${query.search.trim()}"`);
    if (query.overdue === 'true') filters.push('Overdue payments only');

    return {
      rows,
      summary,
      totalMatching,
      timezone: safeTimeZone(this.settings.getSettings(tenantId).timezone),
      generatedAt: new Date(),
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      filters,
    };
  }

  private rangeLabel(data: ReportData): string {
    const tz = data.timezone;
    if (data.dateFrom && data.dateTo)
      return `${fmtDate(data.dateFrom, tz)} – ${fmtDate(data.dateTo, tz)}`;
    if (data.dateFrom) return `From ${fmtDate(data.dateFrom, tz)}`;
    if (data.dateTo) return `Until ${fmtDate(data.dateTo, tz)}`;
    return 'All time';
  }

  // ── Excel ────────────────────────────────────────────────────────────────

  private async renderXlsx(data: ReportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.created = data.generatedAt;
    const ws = wb.addWorksheet('Sales report');

    ws.addRow([`Sales Report — ${this.rangeLabel(data)}`]).font = { bold: true, size: 14 };
    ws.addRow([`Generated ${fmtDateTime(data.generatedAt, data.timezone)} · Amounts in ${CURRENCY_CODE}`]);
    if (data.filters.length > 0) ws.addRow([`Filters: ${data.filters.join(' · ')}`]);
    if (data.totalMatching > data.rows.length) {
      const note = ws.addRow([
        `NOTE: showing first ${data.rows.length} of ${data.totalMatching} matching sales`,
      ]);
      note.font = { color: { argb: 'FFB45309' }, bold: true };
    }
    ws.addRow([]);

    const header = ws.addRow([
      'Sale #',
      'Date',
      'Customer',
      'Cashier',
      'Status',
      'Items',
      'Subtotal',
      'Discount',
      'Tax',
      'Total',
      'Paid',
      'Balance',
      'Payment',
      'Sync',
    ]);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.border = { bottom: { style: 'thin' } };
    });

    for (const r of data.rows) {
      ws.addRow([
        r.saleNumber,
        // Excel has no timezone concept and reads a JS Date's UTC fields, so a
        // raw Date here would show UTC while the PDF shows shop time. Write the
        // already-formatted shop-zone string so both exports agree.
        fmtDateTime(r.completedAt ?? r.createdAt, data.timezone),
        r.customerName ?? 'Walk-in customer',
        r.cashierName ?? '',
        r.status,
        r.itemCount,
        r.subtotal,
        r.totalDiscount + r.orderDiscountAmount,
        r.taxAmount,
        r.total,
        r.paidAmount,
        r.balanceAmount,
        r.paymentStatus,
        r.syncStatus,
      ]);
    }

    ws.addRow([]);
    const totals = ws.addRow([
      'Totals',
      '',
      '',
      '',
      '',
      data.summary.transactions,
      '',
      data.summary.discounts,
      data.summary.tax,
      data.summary.gross,
      data.summary.paid,
      data.summary.outstanding,
      '',
      '',
    ]);
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: 'thin' } };
    });

    const moneyCols = [7, 8, 9, 10, 11, 12];
    for (const col of moneyCols) ws.getColumn(col).numFmt = '#,##0.00';
    ws.getColumn(2).numFmt = 'yyyy-mm-dd hh:mm';
    const widths = [12, 18, 24, 16, 12, 8, 12, 12, 10, 12, 12, 12, 12, 12];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ── PDF ──────────────────────────────────────────────────────────────────

  private renderPdf(data: ReportData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const cols: { label: string; width: number; align?: 'right' }[] = [
        { label: 'Sale #', width: 70 },
        { label: 'Date', width: 95 },
        { label: 'Customer', width: 115 },
        { label: 'Cashier', width: 80 },
        { label: 'Items', width: 35, align: 'right' },
        { label: 'Discount', width: 65, align: 'right' },
        { label: 'Total', width: 75, align: 'right' },
        { label: 'Paid', width: 75, align: 'right' },
        { label: 'Balance', width: 70, align: 'right' },
        { label: 'Payment', width: 60 },
      ];
      const startX = doc.page.margins.left;
      const bottomY = doc.page.height - doc.page.margins.bottom;

      const drawHeaderRow = () => {
        doc.font('Helvetica-Bold').fontSize(8);
        // Pin the row's y: doc.text() advances doc.y after every call, so
        // re-reading it per cell staggers the labels diagonally.
        const y = doc.y;
        let x = startX;
        for (const col of cols) {
          doc.text(col.label, x, y, {
            width: col.width - 6,
            align: col.align ?? 'left',
            lineBreak: false,
          });
          x += col.width;
        }
        doc.y = y + 12;
        doc
          .moveTo(startX, doc.y)
          .lineTo(startX + cols.reduce((s, c) => s + c.width, 0), doc.y)
          .strokeColor('#9ca3af')
          .stroke();
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(8);
      };

      // Title block
      doc.font('Helvetica-Bold').fontSize(16).text(`Sales Report — ${this.rangeLabel(data)}`);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#4b5563')
        .text(
          `Generated ${fmtDateTime(data.generatedAt, data.timezone)} · Amounts in ${CURRENCY_CODE} (${CURRENCY_SYMBOL})` +
            (data.filters.length > 0 ? ` · ${data.filters.join(' · ')}` : ''),
        );
      if (data.totalMatching > data.rows.length) {
        doc
          .fillColor('#b45309')
          .text(`Note: showing first ${data.rows.length} of ${data.totalMatching} matching sales.`);
      }
      doc.fillColor('#111827').moveDown(1);

      drawHeaderRow();

      const rowHeight = 14;
      for (const r of data.rows) {
        if (doc.y + rowHeight > bottomY) {
          doc.addPage();
          drawHeaderRow();
        }
        const y = doc.y;
        const cells = [
          r.saleNumber,
          fmtDateTime(r.completedAt ?? r.createdAt, data.timezone),
          r.customerName ?? 'Walk-in customer',
          r.cashierName ?? '—',
          String(r.itemCount),
          fmtMoney(r.totalDiscount + r.orderDiscountAmount),
          fmtMoney(r.total),
          fmtMoney(r.paidAmount),
          fmtMoney(r.balanceAmount),
          r.paymentStatus,
        ];
        let x = startX;
        cells.forEach((text, i) => {
          doc.text(text, x, y, {
            width: cols[i].width - 6,
            align: cols[i].align ?? 'left',
            lineBreak: false,
            ellipsis: true,
          });
          x += cols[i].width;
        });
        doc.y = y + rowHeight;
      }

      // Summary block (position explicitly — doc.x still points at the last
      // table cell after the positioned text() calls above).
      if (doc.y + 110 > bottomY) doc.addPage();
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(11).text('Summary', startX, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9);
      const s = data.summary;
      const lines: [string, string][] = [
        ['Transactions', String(s.transactions)],
        ['Gross sales', `${CURRENCY_SYMBOL} ${fmtMoney(s.gross)}`],
        ['Total discounts', `${CURRENCY_SYMBOL} ${fmtMoney(s.discounts)}`],
        ['Tax collected', `${CURRENCY_SYMBOL} ${fmtMoney(s.tax)}`],
        ['Payments received', `${CURRENCY_SYMBOL} ${fmtMoney(s.paid)}`],
        ['Outstanding balance', `${CURRENCY_SYMBOL} ${fmtMoney(s.outstanding)}`],
      ];
      for (const [label, value] of lines) {
        const y = doc.y;
        doc.text(label, startX, y, { width: 140, lineBreak: false });
        doc.font('Helvetica-Bold').text(value, startX + 140, y, { width: 160, lineBreak: false });
        doc.font('Helvetica');
        doc.y = y + 14;
      }

      doc.end();
    });
  }
}
