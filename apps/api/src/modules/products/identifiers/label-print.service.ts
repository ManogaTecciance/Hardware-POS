import { BadRequestException, Injectable } from '@nestjs/common';
import { PrintJobType } from '@hardware-pos/database';
import { barcodeSvg, type Symbology } from '@hardware-pos/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import type { LabelSettings } from '../../settings/settings.interfaces';

export interface LabelRequest {
  variantId: string;
  /** How many copies of this variant's label. */
  quantity: number;
}

export interface LabelSheet {
  html: string;
  /** Labels actually drawn. */
  labelCount: number;
  /** Variants that could not be drawn, and why. Never silently dropped. */
  skipped: Array<{ variantId: string; sku: string; reason: string }>;
}

/**
 * Phase 5 `5.7` + `5.8` — render a sheet of product labels and queue it.
 *
 * ## Why this reuses the print-job queue (D106)
 *
 * The queue, the agent polling, the `PENDING → PRINTED → FAILED` lifecycle and
 * the retry behaviour already exist and are in production use. A second table
 * would duplicate four things that are correct today, and the copy is where
 * they drift. `PrintJob.saleId` was widened to nullable for this; every
 * existing job still carries one.
 *
 * ## Why a variant with an unprintable barcode is REPORTED, not skipped
 *
 * `5.9` exists because 18 of the pilot's 20 barcodes carry an invalid check
 * digit and cannot be drawn as EAN-13. Quietly omitting those labels would put
 * a shelf edge with no label on it and give the operator nothing to act on —
 * the exact shape of the `4.19` failure, correct behaviour with an invisible
 * cause. They come back in `skipped`, each with a reason.
 */
@Injectable()
export class LabelPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Build the sheet HTML without queuing anything. */
  async renderSheet(tenantId: string, requests: readonly LabelRequest[]): Promise<LabelSheet> {
    if (requests.length === 0) {
      throw new BadRequestException({
        code: 'NO_LABELS_REQUESTED',
        message: 'Choose at least one variant to print.',
      });
    }

    const settings = await this.settings.getSettingsFresh(tenantId);
    const label = settings.catalogue.label;
    const currency = settings.currency;

    const variants = await this.prisma.productVariant.findMany({
      where: { tenantId, id: { in: requests.map((r) => r.variantId) } },
      select: {
        id: true,
        sku: true,
        barcode: true,
        unitPrice: true,
        product: { select: { name: true } },
        optionValues: {
          select: { option: { select: { name: true } }, dimension: { select: { position: true } } },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    const cells: string[] = [];
    const skipped: LabelSheet['skipped'] = [];

    for (const request of requests) {
      const variant = byId.get(request.variantId);
      if (!variant) {
        skipped.push({
          variantId: request.variantId,
          sku: '—',
          reason: 'That variant does not belong to this workspace.',
        });
        continue;
      }

      const payload = label.symbology === 'EAN13' ? variant.barcode : variant.sku;
      if (!payload) {
        skipped.push({
          variantId: variant.id,
          sku: variant.sku,
          reason: 'No barcode. Generate one before printing EAN-13 labels.',
        });
        continue;
      }

      const svg = barcodeSvg(payload, label.symbology as Symbology, {
        widthMm: Math.max(label.widthMm - 4, 8),
        heightMm: Math.max(label.heightMm * 0.45, 6),
      });
      if (svg === null) {
        skipped.push({
          variantId: variant.id,
          sku: variant.sku,
          reason:
            label.symbology === 'EAN13'
              ? `"${payload}" is not a valid EAN-13 — most likely a wrong check digit. Reissue it under Barcodes before printing.`
              : `"${payload}" contains characters Code 128 subset B cannot encode.`,
        });
        continue;
      }

      const options = [...variant.optionValues]
        .sort((a, b) => a.dimension.position - b.dimension.position)
        .map((ov) => ov.option.name)
        .join(' / ');

      const lines: string[] = [];
      if (label.showProductName) lines.push(`<div class="name">${escapeHtml(variant.product.name)}</div>`);
      if (label.showVariantOptions && options) {
        lines.push(`<div class="opts">${escapeHtml(options)}</div>`);
      }
      lines.push(`<div class="sym">${svg}</div>`);
      lines.push(`<div class="code">${escapeHtml(payload)}</div>`);
      if (label.showSku) lines.push(`<div class="sku">${escapeHtml(variant.sku)}</div>`);
      if (label.showPrice) {
        lines.push(
          `<div class="price">${escapeHtml(currency)} ${Number(variant.unitPrice).toFixed(2)}</div>`,
        );
      }

      const cell = `<div class="label">${lines.join('')}</div>`;
      // `quantity` is copies of the SAME label, which is what a size run needs:
      // twelve of one size, three of another.
      for (let i = 0; i < Math.max(1, request.quantity); i += 1) cells.push(cell);
    }

    return { html: sheetHtml(cells, label), labelCount: cells.length, skipped };
  }

  /**
   * Render and queue.
   *
   * The job is `PRODUCT_LABEL` with no `saleId` — D106. Refuses when nothing
   * could be drawn, so an operator never sees a queued job that will print a
   * blank page.
   */
  async queueSheet(
    tenantId: string,
    requests: readonly LabelRequest[],
    userId: string,
    copies: number,
  ): Promise<{ printJobId: string; labelCount: number; skipped: LabelSheet['skipped'] }> {
    const sheet = await this.renderSheet(tenantId, requests);
    if (sheet.labelCount === 0) {
      throw new BadRequestException({
        code: 'NO_PRINTABLE_LABELS',
        message: 'None of the selected variants could be printed.',
        skipped: sheet.skipped,
      });
    }

    const job = await this.prisma.printJob.create({
      data: {
        tenantId,
        // D106 — the only job type with no sale behind it.
        saleId: null,
        type: PrintJobType.PRODUCT_LABEL,
        html: sheet.html,
        copies: Math.max(1, copies),
        createdByUserId: userId,
      },
      select: { id: true },
    });

    return { printJobId: job.id, labelCount: sheet.labelCount, skipped: sheet.skipped };
  }
}

/**
 * The sheet itself: a CSS grid in millimetres, with `@page` margins so the
 * browser's own print path and a print agent produce the same geometry.
 */
function sheetHtml(cells: string[], label: LabelSettings): string {
  const pageWidth = label.marginLeftMm * 2 + label.columns * label.widthMm + (label.columns - 1) * label.gapXMm;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Product labels</title><style>
  @page { margin: ${label.marginTopMm}mm ${label.marginLeftMm}mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
  .sheet {
    display: grid;
    grid-template-columns: repeat(${label.columns}, ${label.widthMm}mm);
    column-gap: ${label.gapXMm}mm;
    row-gap: ${label.gapYMm}mm;
    width: ${pageWidth}mm;
  }
  .label {
    width: ${label.widthMm}mm; height: ${label.heightMm}mm;
    padding: 1mm; overflow: hidden; text-align: center;
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    /* Page-break inside a label would cut a barcode in half, which scans as
       nothing at all rather than as a wrong product. */
    break-inside: avoid; page-break-inside: avoid;
  }
  .name { font-size: 6pt; font-weight: 700; line-height: 1.1; }
  .opts { font-size: 5.5pt; }
  .sym  { line-height: 0; margin: 0.5mm 0; }
  .code { font-size: 5.5pt; letter-spacing: 0.4pt; font-family: "Courier New", monospace; }
  .sku  { font-size: 5pt; color: #333; }
  .price{ font-size: 7pt; font-weight: 700; }
</style></head>
<body><div class="sheet">${cells.join('')}</div></body></html>`;
}

/** The product name is operator-entered text going into an HTML document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
