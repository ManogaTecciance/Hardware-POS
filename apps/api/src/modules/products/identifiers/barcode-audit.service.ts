import { BadRequestException, Injectable } from '@nestjs/common';
import { BarcodeSource } from '@hardware-pos/database';
import { isValidEan13, looksLikeEan13 } from '@hardware-pos/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { BarcodeGeneratorService } from './barcode-generator.service';

export type BarcodeVerdict =
  /** 13 digits, correct check digit. Nothing to do. */
  | 'VALID_EAN13'
  /** 13 digits, WRONG check digit. No scanner or renderer will accept it. */
  | 'INVALID_CHECK_DIGIT'
  /** Not 13 digits — a supplier CODE128 or similar. Not ours to judge. */
  | 'NOT_EAN13';

export interface BarcodeAuditRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  barcode: string;
  verdict: BarcodeVerdict;
  source: BarcodeSource | null;
}

export interface BarcodeAuditReport {
  scanned: number;
  withBarcode: number;
  valid: number;
  invalidCheckDigit: number;
  notEan13: number;
  /** Only the rows that need attention. A clean catalogue reports none. */
  problems: BarcodeAuditRow[];
}

/**
 * D104 Part 3 — find and reissue barcodes that cannot be printed (`5.9`).
 *
 * ## Why this step exists
 *
 * The D104 investigation measured the pilot database and found **18 of 20
 * barcodes carry an invalid EAN-13 check digit** — two generators in play, and
 * neither computed one. The prefix is right (`2`, the GS1 in-store range), so
 * nothing looks wrong until `5.7` renders a label, which cannot produce an
 * EAN-13 symbol from an invalid payload. That failure would have read as a
 * rendering bug.
 *
 * ## Report first, reissue never implicitly
 *
 * Two separate operations, and the destructive one takes an explicit list of
 * variant ids. There is deliberately no "fix everything" call: this rewrites
 * identifiers that may be printed on something, and the operator has to be the
 * one who decides which rows to touch.
 *
 * ## Nothing is destroyed silently
 *
 * Every reissue writes an audit event carrying the OLD barcode, so a wrongly
 * reissued code can be recovered from the permanent record. Without that, this
 * operation would be exactly the "silently rewrite existing barcode data" that
 * D104 warns against.
 *
 * ## A supplier's barcode is never reissued
 *
 * Even when invalid. A supplier's code that fails a check digit is the
 * supplier's problem to explain, and overwriting it would break the scan path
 * against the physical box. Only `INTERNAL` — or a code this service can see is
 * ours because it sits under the tenant's own prefix — is eligible.
 */
@Injectable()
export class BarcodeAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly barcodes: BarcodeGeneratorService,
    private readonly audit: AuditLogService,
  ) {}

  /** Read-only. Classify every barcode this tenant holds. */
  async report(tenantId: string): Promise<BarcodeAuditReport> {
    const rows = await this.prisma.productVariant.findMany({
      where: { tenantId },
      select: {
        id: true,
        productId: true,
        sku: true,
        barcode: true,
        barcodeSource: true,
        product: { select: { name: true } },
      },
      orderBy: [{ sku: 'asc' }],
    });

    const report: BarcodeAuditReport = {
      scanned: rows.length,
      withBarcode: 0,
      valid: 0,
      invalidCheckDigit: 0,
      notEan13: 0,
      problems: [],
    };

    for (const row of rows) {
      if (!row.barcode) continue;
      report.withBarcode += 1;
      const verdict = classify(row.barcode);
      if (verdict === 'VALID_EAN13') report.valid += 1;
      else if (verdict === 'NOT_EAN13') report.notEan13 += 1;
      else {
        report.invalidCheckDigit += 1;
        report.problems.push({
          variantId: row.id,
          productId: row.productId,
          productName: row.product.name,
          sku: row.sku,
          barcode: row.barcode,
          verdict,
          source: row.barcodeSource,
        });
      }
    }
    return report;
  }

  /**
   * Reissue the named variants' barcodes.
   *
   * Refuses the whole request if any named variant is ineligible, rather than
   * reissuing the eligible subset. A partial result would leave the operator
   * unsure which rows changed, and the fix for that is a clear refusal.
   */
  async reissue(
    tenantId: string,
    variantIds: readonly string[],
    userId: string,
  ): Promise<BarcodeAuditRow[]> {
    if (variantIds.length === 0) {
      throw new BadRequestException({
        code: 'NO_VARIANTS_SELECTED',
        message: 'Name the variants to reissue. There is no bulk "fix everything".',
      });
    }

    const rows = await this.prisma.productVariant.findMany({
      where: { tenantId, id: { in: [...variantIds] } },
      select: {
        id: true,
        productId: true,
        sku: true,
        barcode: true,
        barcodeSource: true,
        product: { select: { name: true, categoryId: true } },
      },
    });

    if (rows.length !== variantIds.length) {
      throw new BadRequestException({
        code: 'VARIANT_NOT_FOUND',
        message: 'One or more of those variants do not belong to this tenant.',
      });
    }

    for (const row of rows) {
      if (row.barcode === null) {
        throw new BadRequestException({
          code: 'NOTHING_TO_REISSUE',
          message: `${row.sku} has no barcode. Generate one instead of reissuing.`,
        });
      }
      if (row.barcodeSource === BarcodeSource.SUPPLIER) {
        throw new BadRequestException({
          code: 'SUPPLIER_BARCODE',
          message: `${row.sku} carries a supplier barcode. Reissuing it would break the code printed on the box.`,
        });
      }
      if (classify(row.barcode) === 'NOT_EAN13') {
        throw new BadRequestException({
          code: 'NOT_AN_EAN13',
          message: `${row.sku} carries "${row.barcode}", which is not a 13-digit code. Nothing about it is wrong for this check to fix.`,
        });
      }
    }

    // One prefix for the batch. Per-category prefixes are resolved from the
    // first row's category — a reissue pass is a single operator action over a
    // selection they made, not a catalogue-wide sweep.
    const prefix = await this.barcodes.prefixFor(tenantId, rows[0].product.categoryId ?? null);

    const updated: BarcodeAuditRow[] = [];
    await this.prisma.$transaction(async (tx) => {
      const allocated = await this.barcodes.allocateMany(tx, tenantId, prefix, rows.length);
      for (const [i, row] of rows.entries()) {
        const next = allocated[i].barcode;
        await tx.productVariant.update({
          where: { id: row.id },
          data: { barcode: next, barcodeSource: BarcodeSource.INTERNAL },
        });
        updated.push({
          variantId: row.id,
          productId: row.productId,
          productName: row.product.name,
          sku: row.sku,
          barcode: next,
          verdict: 'VALID_EAN13',
          source: BarcodeSource.INTERNAL,
        });
      }
    });

    // Outside the transaction: the audit trail must survive even if a later
    // step fails, and an audit write must never be the thing that rolls back a
    // successful correction.
    for (const [i, row] of rows.entries()) {
      await this.audit.record(tenantId, {
        userId,
        action: 'BARCODE_REISSUED',
        entityType: 'ProductVariant',
        entityId: row.id,
        metadata: {
          sku: row.sku,
          // The whole point: the old value is recoverable.
          previousBarcode: row.barcode,
          previousBarcodeSource: row.barcodeSource,
          newBarcode: updated[i].barcode,
          reason: 'INVALID_EAN13_CHECK_DIGIT',
        },
      });
    }

    return updated;
  }
}

/** Shape first, validity second — see `BarcodeGeneratorService.assertTypedBarcode`. */
function classify(barcode: string): BarcodeVerdict {
  if (!looksLikeEan13(barcode)) return 'NOT_EAN13';
  return isValidEan13(barcode) ? 'VALID_EAN13' : 'INVALID_CHECK_DIGIT';
}
