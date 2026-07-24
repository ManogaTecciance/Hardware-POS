import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

import { PrismaService } from '../../prisma/prisma.service';
import { ImportSupplierRowDto } from './dto/commit-import.dto';
import { SuppliersService } from './suppliers.service';

/** A parsed + validated vendor row returned by the preview step (no DB writes). */
export interface ParsedSupplierRow {
  /** 1-based source row in the sheet — the stable key through preview → commit. */
  rowNumber: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  openingBalance: number | null;
  openingBalanceDate: string | null;
  taxId: string | null;
  /** Whether this row would create a new vendor or update an existing match. */
  matchStatus: 'create' | 'update';
  /** Validation problems; a row is committable only when this is empty. */
  errors: string[];
}

export interface ImportCommitResult {
  rowNumber: number;
  supplierId: string | null;
  outcome: 'created' | 'updated' | 'failed';
  error?: string;
}

export interface ImportCommitSummary {
  created: number;
  updated: number;
  failed: number;
  results: ImportCommitResult[];
}

/** Header names exactly as in the QuickBooks Online Vendor import template. */
const H = {
  name: 'Name',
  company: 'Company',
  email: 'Email',
  phone: 'Phone',
  mobile: 'Mobile',
  fax: 'Fax',
  website: 'Website',
  street: 'Street',
  city: 'City',
  province: 'Province/Region/State',
  postalCode: 'Postal code',
  country: 'Country',
  openingBalance: 'Opening Balance',
  date: 'Date',
  taxId: 'Tax Id Number',
} as const;

const TEMPLATE_HEADERS: string[] = [
  H.name,
  H.company,
  H.email,
  H.phone,
  H.mobile,
  H.fax,
  H.website,
  H.street,
  H.city,
  H.province,
  H.postalCode,
  H.country,
  H.openingBalance,
  H.date,
  H.taxId,
];

/** Example rows shipped in the template so the expected shape is obvious. */
const TEMPLATE_SAMPLES: Array<Array<string | number>> = [
  ['Nimal Perera', 'Lanka Hardware Distributors', 'sales@lankahw.lk', '+94 11 234 5678', '+94 77 123 4567', '', 'http://www.lankahw.lk', '120 Main Street', 'Colombo', 'Western', '00100', 'Sri Lanka', 250000, '2026-01-01', 'VAT-889231'],
  ['Kamala Silva', 'Ceylon Fasteners Ltd', 'kamala@ceylonfasteners.lk', '+94 11 456 7890', '', '', '', '45 Industrial Zone', 'Kandy', 'Central', '20000', 'Sri Lanka', '', '', ''],
];

type CellValue = ExcelJS.CellValue;

/** Collapse exceljs cell values (formula results, rich text, hyperlinks, dates) to a primitive. */
function plain(v: CellValue): string | number | Date {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as { result?: CellValue; text?: string; richText?: Array<{ text: string }> };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.result != null) return plain(o.result);
    if (o.text != null) return o.text;
    return '';
  }
  return v as string | number;
}

function asText(v: string | number | Date): string {
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** Parse a numeric cell; returns the value, or 'invalid' when non-empty but not a number. */
function asNumberField(v: string | number | Date): number | null | 'invalid' {
  const s = asText(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : 'invalid';
}

/** Parse a date cell: a Date cell, M/D/YYYY, or YYYY-MM-DD. */
function asDate(v: string | number | Date): string | null | 'invalid' {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const s = asText(v);
  if (!s) return null;
  const mdY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = mdY ? new Date(Number(mdY[3]), Number(mdY[1]) - 1, Number(mdY[2])) : new Date(s);
  return Number.isNaN(date.getTime()) ? 'invalid' : date.toISOString();
}

/**
 * Bulk vendor import from the QuickBooks Online Vendor template (.xlsx or
 * .csv). The same two-phase flow as products: {@link preview} parses and
 * validates without writing anything so the client can review, then
 * {@link commit} creates/updates vendors by display name.
 */
@Injectable()
export class SuppliersImportService {
  private readonly logger = new Logger(SuppliersImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppliersService: SuppliersService,
  ) {}

  /** A ready-to-fill .xlsx template with the QuickBooks vendor headers + examples. */
  async buildTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Vendors');
    const header = ws.addRow(TEMPLATE_HEADERS);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.border = { bottom: { style: 'thin' } };
    });
    for (const sample of TEMPLATE_SAMPLES) ws.addRow(sample);
    TEMPLATE_HEADERS.forEach((h, i) => {
      ws.getColumn(i + 1).width = Math.max(14, Math.min(34, h.length + 6));
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Parse + validate the sheet without writing anything (the review step). */
  async preview(
    tenantId: string,
    file: { buffer: Buffer; originalname?: string },
  ): Promise<ParsedSupplierRow[]> {
    const rawRows = await this.parse(file);
    const rows: ParsedSupplierRow[] = [];
    const nameSeen = new Map<string, number>(); // lower(name) → first rowNumber

    for (const { rowNumber, cells } of rawRows) {
      const get = (h: string) => cells.get(h) ?? '';
      const name = asText(get(H.name));
      if (!name) continue; // blank/padding row
      // Note rows (e.g. the QB sample's trailing "All data is for sample
      // purposes only"): a multi-line "name" with every other column empty.
      if (name.includes('\n')) {
        const hasData = TEMPLATE_HEADERS.some((h) => h !== H.name && asText(get(h)) !== '');
        if (!hasData) continue;
      }

      const errors: string[] = [];

      const openingBalance = asNumberField(get(H.openingBalance));
      if (openingBalance === 'invalid') errors.push('Opening Balance is not a number');
      const openingBalanceDate = asDate(get(H.date));
      if (openingBalanceDate === 'invalid') errors.push('Date is not a valid date');

      const key = name.toLowerCase();
      const firstAt = nameSeen.get(key);
      if (firstAt) errors.push(`Duplicate name "${name}" (also on row ${firstAt})`);
      else nameSeen.set(key, rowNumber);

      const existing = await this.prisma.supplier.findFirst({
        where: { tenantId, name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });

      rows.push({
        rowNumber,
        name,
        company: asText(get(H.company)) || null,
        email: asText(get(H.email)) || null,
        phone: asText(get(H.phone)) || null,
        mobile: asText(get(H.mobile)) || null,
        fax: asText(get(H.fax)) || null,
        website: asText(get(H.website)) || null,
        street: asText(get(H.street)) || null,
        city: asText(get(H.city)) || null,
        province: asText(get(H.province)) || null,
        postalCode: asText(get(H.postalCode)) || null,
        country: asText(get(H.country)) || null,
        openingBalance: typeof openingBalance === 'number' ? openingBalance : null,
        openingBalanceDate: typeof openingBalanceDate === 'string' ? openingBalanceDate : null,
        taxId: asText(get(H.taxId)) || null,
        matchStatus: existing ? 'update' : 'create',
        errors,
      });
    }

    if (rows.length === 0) {
      throw new BadRequestException('No vendor rows found in the sheet');
    }
    return rows;
  }

  /** Create/update the reviewed rows and report each row's outcome. */
  async commit(tenantId: string, rows: ImportSupplierRowDto[]): Promise<ImportCommitSummary> {
    const summary: ImportCommitSummary = { created: 0, updated: 0, failed: 0, results: [] };

    for (const row of rows) {
      try {
        const existing = await this.prisma.supplier.findFirst({
          where: { tenantId, name: { equals: row.name, mode: 'insensitive' } },
          select: { id: true },
        });
        const saved = existing
          ? await this.suppliersService.update(tenantId, existing.id, row)
          : await this.suppliersService.create(tenantId, row);
        summary[existing ? 'updated' : 'created']++;
        summary.results.push({
          rowNumber: row.rowNumber,
          supplierId: saved.id,
          outcome: existing ? 'updated' : 'created',
        });
      } catch (err) {
        summary.failed++;
        summary.results.push({
          rowNumber: row.rowNumber,
          supplierId: null,
          outcome: 'failed',
          error: err instanceof Error ? err.message : 'Could not import row',
        });
      }
    }

    this.logger.log(
      `Vendor import commit for ${tenantId}: ${summary.created} created, ${summary.updated} updated, ${summary.failed} failed`,
    );
    return summary;
  }

  /** Read the sheet (first worksheet) into header-keyed rows. */
  private async parse(file: {
    buffer: Buffer;
    originalname?: string;
  }): Promise<Array<{ rowNumber: number; cells: Map<string, string | number | Date> }>> {
    const workbook = new ExcelJS.Workbook();
    const isCsv = (file.originalname ?? '').toLowerCase().endsWith('.csv');
    try {
      if (isCsv) {
        await workbook.csv.read(Readable.from(file.buffer));
      } else {
        await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
      }
    } catch {
      throw new BadRequestException(
        'Could not read the file — upload the QuickBooks vendor template as .xlsx or .csv (re-save legacy .xls as .xlsx first)',
      );
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('The uploaded file has no sheets');

    // Header row: must contain the template's Name column.
    let headerRowNumber = 0;
    const headerByIndex = new Map<number, string>();
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (headerRowNumber) return;
      const values = (row.values as CellValue[]).slice(1).map(plain);
      if (values.some((v) => asText(v) === H.name)) {
        headerRowNumber = n;
        values.forEach((v, i) => {
          const label = asText(v);
          if (label) headerByIndex.set(i, label);
        });
      }
    });
    if (!headerRowNumber) {
      throw new BadRequestException(
        `Header row not found — the sheet needs a "${H.name}" column like the QuickBooks vendor template`,
      );
    }

    const rows: Array<{ rowNumber: number; cells: Map<string, string | number | Date> }> = [];
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n <= headerRowNumber) return;
      const values = (row.values as CellValue[]).slice(1).map(plain);
      const cells = new Map<string, string | number | Date>();
      headerByIndex.forEach((label, i) => cells.set(label, values[i] ?? ''));
      rows.push({ rowNumber: n, cells });
    });
    return rows;
  }
}
