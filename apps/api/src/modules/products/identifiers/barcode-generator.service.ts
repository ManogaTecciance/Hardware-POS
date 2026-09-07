import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BarcodeSource, Prisma } from '@hardware-pos/database';
import {
  composeInStoreEan13,
  ean13PrefixIssue,
  isValidEan13,
  looksLikeEan13,
} from '@hardware-pos/shared';

import { nextDocumentNumber } from '../../../common/document-sequence';
import { PrismaService } from '../../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';

export interface AllocatedBarcode {
  barcode: string;
  source: BarcodeSource;
}

/** Bounded, like the SKU generator's — a loop is worse than an error. */
const MAX_ATTEMPTS = 5;

/**
 * D104 Part 3 — allocate in-store EAN-13 barcodes (`5.4`, `5.5`, `5.6`).
 *
 * ## The sequencing constraint is enforced, not documented
 *
 * D104 adopts as binding: the prefix map must be configured BEFORE any
 * allocation, or the tenant reprints every label. So allocation REFUSES while
 * `catalogue.barcodePrefix` is null. A default prefix would be the failure the
 * constraint exists to prevent — silently committing a shop to a number nobody
 * chose, discovered only once the labels are printed.
 *
 * ## Every generated code carries a correct check digit
 *
 * That is the entire point. The pilot database holds 18 barcodes that do not,
 * from two generators neither of which computed one, and they would have failed
 * at `5.7` looking like a rendering bug.
 *
 * ## A supplier barcode is never overwritten
 *
 * `barcodeSource` answers the only question the system asks: may I regenerate
 * this? SUPPLIER means no. NULL means unknown, and unknown is also treated as
 * no — the twenty pilot codes predate the flag, and guessing would authorise
 * destroying a manufacturer's code.
 */
@Injectable()
export class BarcodeGeneratorService {
  private readonly logger = new Logger(BarcodeGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The prefix this tenant allocates from, refusing when unconfigured.
   *
   * `categoryId` selects a per-category override when one exists; a shop with
   * one prefix never notices the map.
   */
  async prefixFor(tenantId: string, categoryId: string | null): Promise<string> {
    const settings = await this.settings.getSettingsFresh(tenantId);
    const catalogue = settings.catalogue;
    const configured =
      (categoryId ? catalogue.barcodePrefixByCategoryId?.[categoryId] : null) ??
      catalogue.barcodePrefix;

    if (!configured) {
      throw new BadRequestException({
        code: 'BARCODE_PREFIX_NOT_CONFIGURED',
        message:
          'No barcode prefix is configured for this workspace. Set one in Settings before generating barcodes — changing it later means reprinting every label already produced.',
      });
    }

    const issue = ean13PrefixIssue(configured);
    if (issue) {
      throw new BadRequestException({ code: 'BARCODE_PREFIX_INVALID', message: issue });
    }
    return configured;
  }

  /**
   * Allocate `count` barcodes inside the caller's transaction.
   *
   * Uniqueness is checked before returning, not left to the insert: the same
   * generated value could already be occupied by a supplier code typed in by
   * hand, and `@@unique([tenantId, barcode])` would surface that as a P2002
   * with nothing to say about which row caused it.
   */
  async allocateMany(
    tx: Prisma.TransactionClient,
    tenantId: string,
    prefix: string,
    count: number,
  ): Promise<AllocatedBarcode[]> {
    const out: AllocatedBarcode[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await this.allocateOne(tx, tenantId, prefix));
    }
    return out;
  }

  private async allocateOne(
    tx: Prisma.TransactionClient,
    tenantId: string,
    prefix: string,
  ): Promise<AllocatedBarcode> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const sequence = await nextDocumentNumber(tx, tenantId, 'BARCODE');
      const barcode = composeInStoreEan13(prefix, sequence);

      if (barcode === null) {
        // A real end of range. Truncating or wrapping would REISSUE a code
        // that is already on a printed label, which is worse than refusing.
        throw new BadRequestException({
          code: 'BARCODE_RANGE_EXHAUSTED',
          message: `The barcode range for prefix ${prefix} is exhausted. A shorter prefix gives more codes.`,
        });
      }

      const taken = await tx.productVariant.findFirst({
        where: { tenantId, barcode },
        select: { id: true },
      });
      if (!taken) return { barcode, source: BarcodeSource.INTERNAL };

      this.logger.warn(
        `Generated barcode ${barcode} is already taken for tenant ${tenantId}; re-allocating (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      );
    }
    throw new Error(
      `Could not allocate a unique barcode for tenant ${tenantId} after ${MAX_ATTEMPTS} attempts.`,
    );
  }

  /**
   * Validate a barcode an operator typed (`5.6`).
   *
   * The rule keys on SHAPE, not on origin, so it cannot reject a valid supplier
   * code: 13 digits is a claim to be an EAN-13 and must carry the right check
   * digit; anything else is a CODE128 alphanumeric or similar and is accepted
   * as the supplier printed it.
   */
  assertTypedBarcode(value: string): void {
    if (looksLikeEan13(value) && !isValidEan13(value)) {
      throw new BadRequestException({
        code: 'BARCODE_CHECK_DIGIT_INVALID',
        message: `${value} is 13 digits but its check digit is wrong, so no scanner or label renderer will accept it. Re-check the last digit, or leave the field empty to have one generated.`,
      });
    }
  }

  /**
   * May this variant's barcode be replaced?
   *
   * SUPPLIER is a no. NULL — unknown — is also a no, deliberately: the pilot's
   * twenty codes predate the flag, and treating unknown as "mine to overwrite"
   * is exactly how a manufacturer's barcode gets destroyed.
   */
  static mayRegenerate(variant: {
    barcode: string | null;
    barcodeSource: BarcodeSource | null;
  }): boolean {
    if (variant.barcode === null) return true;
    return variant.barcodeSource === BarcodeSource.INTERNAL;
  }
}
