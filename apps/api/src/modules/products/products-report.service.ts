import { Injectable } from '@nestjs/common';
import {
  CURRENCY_CODE,
  CURRENCY_LOCALE,
  CURRENCY_SYMBOL,
  dayInTimeZone,
  formatDateTimeInTimeZone,
  safeTimeZone,
} from '@hardware-pos/shared';
import { Product } from '@hardware-pos/database';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ProductsRepository } from './products.repository';
import { QueryProductsReportDto } from './dto/query-products-report.dto';

/** Hard cap so a runaway filter can't build an unbounded file in memory. */
const MAX_REPORT_ROWS = 5000;

export interface GeneratedReport {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

interface ReportRow {
  name: string;
  type: string;
  sku: string | null;
  category: string;
  unitPrice: number;
  costPrice: number | null;
  quantityOnHand: number;
  reorderLevel: number | null;
  /** On-hand valuation: quantity × cost (0 when the cost is unknown). */
  stockValue: number;
  isActive: boolean;
  syncStatus: string;
}

interface ReportSummary {
  products: number;
  inventoryItems: number;
  unitsOnHand: number;
  stockValue: number;
  outOfStock: number;
  lowStock: number;
}

interface ReportData {
  rows: ReportRow[];
  summary: ReportSummary;
  totalMatching: number;
  /** Shop timezone every date in this report is rendered in. */
  timezone: string;
  generatedAt: Date;
  filters: string[];
}

const money = new Intl.NumberFormat(CURRENCY_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtMoney = (n: number): string => money.format(n);

/** Reports are documents: their dates read in the SHOP's zone, not the server's. */
function fmtDateTime(d: Date, tz: string): string {
  return formatDateTimeInTimeZone(d, tz, CURRENCY_LOCALE);
}

const TYPE_LABEL: Record<string, string> = {
  Inventory: 'Inventory',
  NonInventory: 'Non-Inventory',
  Service: 'Service',
};

/** Stock report over the product catalog, honouring the same filters as the list. */
@Injectable()
export class ProductsReportService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async generate(tenantId: string, query: QueryProductsReportDto): Promise<GeneratedReport> {
    const data = await this.buildData(tenantId, query);
    const stamp = dayInTimeZone(data.generatedAt, data.timezone);
    if (query.format === 'xlsx') {
      return {
        buffer: await this.renderXlsx(data),
        filename: `stock-report-${stamp}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    return {
      buffer: await this.renderPdf(data),
      filename: `stock-report-${stamp}.pdf`,
      contentType: 'application/pdf',
    };
  }

  private async buildData(tenantId: string, query: QueryProductsReportDto): Promise<ReportData> {
    const [products, totalMatching] = await this.productsRepository.listManaged(
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
      0,
      MAX_REPORT_ROWS,
    );

    const categories = await this.prisma.productCategory.findMany({
      where: { tenantId },
      select: { id: true, name: true },
    });
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));

    const rows = products.map((p): ReportRow => this.toRow(p, categoryName));

    const summary = rows.reduce<ReportSummary>(
      (acc, r) => {
        const inventory = r.type === 'Inventory';
        return {
          products: acc.products + 1,
          inventoryItems: acc.inventoryItems + (inventory ? 1 : 0),
          unitsOnHand: acc.unitsOnHand + (inventory ? r.quantityOnHand : 0),
          stockValue: acc.stockValue + r.stockValue,
          outOfStock: acc.outOfStock + (inventory && r.quantityOnHand <= 0 ? 1 : 0),
          lowStock:
            acc.lowStock +
            (inventory &&
            r.reorderLevel != null &&
            r.quantityOnHand > 0 &&
            r.quantityOnHand <= r.reorderLevel
              ? 1
              : 0),
        };
      },
      { products: 0, inventoryItems: 0, unitsOnHand: 0, stockValue: 0, outOfStock: 0, lowStock: 0 },
    );

    const filters: string[] = [];
    if (query.search?.trim()) filters.push(`Search: "${query.search.trim()}"`);
    if (query.categoryId) {
      filters.push(`Category: ${categoryName.get(query.categoryId) ?? query.categoryId}`);
    }
    if (query.type) filters.push(`Type: ${TYPE_LABEL[query.type] ?? query.type}`);
    if (query.stockStatus) {
      filters.push(
        `Stock: ${query.stockStatus === 'OUT' ? 'Out of stock' : query.stockStatus === 'LOW' ? 'Low stock' : 'In stock'}`,
      );
    }
    if (query.syncStatus) filters.push(`Sync: ${query.syncStatus}`);
    if (query.isActive) filters.push(query.isActive === 'true' ? 'Active only' : 'Inactive only');

    return {
      rows,
      summary,
      totalMatching,
      timezone: safeTimeZone(this.settings.getSettings(tenantId).timezone),
      generatedAt: new Date(),
      filters,
    };
  }

  private toRow(p: Product, categoryName: Map<string, string>): ReportRow {
    const qty = Number(p.quantityOnHand);
    const cost = p.costPrice != null ? Number(p.costPrice) : null;
    return {
      name: p.name,
      type: p.type,
      sku: p.sku,
      category: (p.categoryId && categoryName.get(p.categoryId)) || 'Uncategorized',
      unitPrice: Number(p.unitPrice),
      costPrice: cost,
      quantityOnHand: qty,
      reorderLevel: p.reorderLevel != null ? Number(p.reorderLevel) : null,
      stockValue: p.type === 'Inventory' && cost != null ? qty * cost : 0,
      isActive: p.isActive,
      syncStatus: p.syncStatus,
    };
  }

  // ── Excel ────────────────────────────────────────────────────────────────

  private async renderXlsx(data: ReportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.created = data.generatedAt;
    const ws = wb.addWorksheet('Stock report');

    ws.addRow(['Stock Report']).font = { bold: true, size: 14 };
    ws.addRow([`Generated ${fmtDateTime(data.generatedAt, data.timezone)} · Amounts in ${CURRENCY_CODE}`]);
    if (data.filters.length > 0) ws.addRow([`Filters: ${data.filters.join(' · ')}`]);
    if (data.totalMatching > data.rows.length) {
      const note = ws.addRow([
        `NOTE: showing first ${data.rows.length} of ${data.totalMatching} matching products`,
      ]);
      note.font = { color: { argb: 'FFB45309' }, bold: true };
    }
    ws.addRow([]);

    const header = ws.addRow([
      'Product',
      'Type',
      'SKU',
      'Category',
      'Sales price',
      'Purchase cost',
      'On hand',
      'Reorder point',
      'Stock value',
      'Status',
      'Sync',
    ]);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.border = { bottom: { style: 'thin' } };
    });

    for (const r of data.rows) {
      ws.addRow([
        r.name,
        TYPE_LABEL[r.type] ?? r.type,
        r.sku ?? '',
        r.category,
        r.unitPrice,
        r.costPrice ?? '',
        r.type === 'Inventory' ? r.quantityOnHand : '',
        r.reorderLevel ?? '',
        r.type === 'Inventory' ? r.stockValue : '',
        r.isActive ? 'Active' : 'Inactive',
        r.syncStatus,
      ]);
    }

    ws.addRow([]);
    const s = data.summary;
    const totals = ws.addRow(['Totals', '', '', '', '', '', s.unitsOnHand, '', s.stockValue, '', '']);
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: 'thin' } };
    });
    ws.addRow([]);
    ws.addRow(['Products', s.products]);
    ws.addRow(['Inventory items', s.inventoryItems]);
    ws.addRow(['Out of stock', s.outOfStock]);
    ws.addRow(['Low stock', s.lowStock]);

    const moneyCols = [5, 6, 9];
    for (const col of moneyCols) ws.getColumn(col).numFmt = '#,##0.00';
    const widths = [32, 14, 14, 20, 13, 13, 10, 13, 14, 10, 12];
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
        { label: 'Product', width: 190 },
        { label: 'Type', width: 70 },
        { label: 'SKU', width: 70 },
        { label: 'Category', width: 95 },
        { label: 'Price', width: 70, align: 'right' },
        { label: 'Cost', width: 70, align: 'right' },
        { label: 'On hand', width: 55, align: 'right' },
        { label: 'Reorder', width: 50, align: 'right' },
        { label: 'Stock value', width: 80, align: 'right' },
      ];
      const startX = doc.page.margins.left;
      const bottomY = doc.page.height - doc.page.margins.bottom;

      const drawHeaderRow = () => {
        doc.font('Helvetica-Bold').fontSize(8);
        // Pin the row's y: doc.text() advances doc.y after every call.
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
          .lineTo(startX + cols.reduce((sum, c) => sum + c.width, 0), doc.y)
          .strokeColor('#9ca3af')
          .stroke();
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(8);
      };

      // Title block
      doc.font('Helvetica-Bold').fontSize(16).text('Stock Report');
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
          .text(`Note: showing first ${data.rows.length} of ${data.totalMatching} matching products.`);
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
        const inventory = r.type === 'Inventory';
        const cells = [
          r.name,
          TYPE_LABEL[r.type] ?? r.type,
          r.sku ?? '—',
          r.category,
          fmtMoney(r.unitPrice),
          r.costPrice != null ? fmtMoney(r.costPrice) : '—',
          inventory ? String(r.quantityOnHand) : '—',
          r.reorderLevel != null ? String(r.reorderLevel) : '—',
          inventory ? fmtMoney(r.stockValue) : '—',
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

      // Summary block (position explicitly — doc.x points at the last cell).
      if (doc.y + 120 > bottomY) doc.addPage();
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(11).text('Summary', startX, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9);
      const s = data.summary;
      const lines: [string, string][] = [
        ['Products', String(s.products)],
        ['Inventory items', String(s.inventoryItems)],
        ['Units on hand', String(s.unitsOnHand)],
        ['Stock value (cost)', `${CURRENCY_SYMBOL} ${fmtMoney(s.stockValue)}`],
        ['Out of stock', String(s.outOfStock)],
        ['Low stock', String(s.lowStock)],
      ];
      for (const [label, value] of lines) {
        const y = doc.y;
        doc.text(label, startX, y, { width: 140, lineBreak: false });
        doc.font('Helvetica-Bold').text(value, startX + 140, y, { width: 180, lineBreak: false });
        doc.font('Helvetica');
        doc.y = y + 14;
      }

      doc.end();
    });
  }
}
