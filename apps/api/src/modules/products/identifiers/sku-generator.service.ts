import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import { composeSku, resolveOptionCodes, skuCategorySegment } from '@hardware-pos/shared';

import { nextDocumentNumber } from '../../../common/document-sequence';
import { PrismaService } from '../../../prisma/prisma.service';

/** One variant's identity, as far as SKU generation is concerned. */
export interface SkuRequest {
  /** Option names + mapped library codes, in the product's dimension order. */
  options: ReadonlyArray<{ name: string; libraryCode: string | null }>;
}

export interface GeneratedSku {
  sku: string;
  /** True when every segment came from the library, i.e. the SKU is stable. */
  fullyMapped: boolean;
}

/**
 * How many times to re-allocate after a collision before giving up.
 *
 * A collision means a hand-typed SKU already occupies the composed string. One
 * retry usually clears it because the sequence has moved on; three is generous
 * and still bounded, so a pathological catalogue produces an error rather than
 * a loop.
 */
const MAX_ATTEMPTS = 3;

/**
 * D125 — generate `<CATEGORY>-<SEQ>[-<OPTION CODE>…]` for a variant.
 *
 * ## Why `DocumentSequence` and not a new table
 *
 * `nextDocumentNumber` is already this repository's answer to "two tills
 * allocate a number at the same instant", proven by sale, return, quotation,
 * table-session, reservation and receipt numbering. A second mechanism for SKUs
 * would be a second thing to get wrong under concurrency, and it would have to
 * be re-proven from scratch.
 *
 * ## Gaps are accepted
 *
 * The allocation increments inside the caller's transaction, so a rolled-back
 * product creation burns a number. A gap-free sequence would need a lock held
 * across the whole create — exactly the contention the existing design avoids.
 * A SKU is an identifier, not an audit trail; nobody reconciles them.
 *
 * ## Uniqueness is the database's job, not this service's
 *
 * `ProductVariant` carries `@@unique([tenantId, sku])`, so a generated SKU that
 * collides with a hand-typed one fails at the database rather than silently
 * duplicating. This service retries on that collision; it does not assume the
 * sequence alone is sufficient, because it is not — an operator may type
 * anything into the override field.
 */
@Injectable()
export class SkuGeneratorService {
  private readonly logger = new Logger(SkuGeneratorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate one SKU per request, inside the caller's transaction.
   *
   * Each variant gets its OWN sequence number rather than sharing one across
   * the batch. Sharing would read better (`APPAREL-0007-BLK-S`,
   * `APPAREL-0007-BLK-M`) but it would make the SKU non-unique the moment a
   * product has an unmapped axis that resolves to the same code, and it would
   * mean a SKU no longer identifies a variant on its own.
   */
  async generateMany(
    tx: Prisma.TransactionClient,
    tenantId: string,
    categoryName: string | null,
    requests: readonly SkuRequest[],
  ): Promise<GeneratedSku[]> {
    const segment = skuCategorySegment(categoryName);
    const out: GeneratedSku[] = [];
    for (const request of requests) {
      out.push(await this.generateOne(tx, tenantId, segment, request));
    }
    return out;
  }

  private async generateOne(
    tx: Prisma.TransactionClient,
    tenantId: string,
    categorySegment: string,
    request: SkuRequest,
  ): Promise<GeneratedSku> {
    const resolved = resolveOptionCodes(request.options);

    // `null` means an option's name yields nothing a code may carry and it is
    // not mapped. Dropping the segment would produce an identifier that could
    // collide with a genuine shorter one, so the axes are dropped ENTIRELY and
    // the sequence alone identifies the variant. Ugly, unique, and honest.
    const optionCodes = resolved === null ? [] : resolved.map((r) => r.code);
    const fullyMapped =
      resolved !== null && resolved.length > 0 && resolved.every((r) => r.source === 'LIBRARY');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const sequence = await nextDocumentNumber(tx, tenantId, 'SKU');
      const sku = composeSku({ categorySegment, sequence, optionCodes });

      const taken = await tx.productVariant.findFirst({
        where: { tenantId, sku },
        select: { id: true },
      });
      if (!taken) return { sku, fullyMapped };

      this.logger.warn(
        `Generated SKU "${sku}" is already taken for tenant ${tenantId}; re-allocating (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      );
    }

    // Deliberately an error rather than a random suffix. A SKU nobody chose,
    // appearing because generation gave up, is worse than a refusal the
    // operator can act on.
    throw new Error(
      `Could not generate a unique SKU for tenant ${tenantId} after ${MAX_ATTEMPTS} attempts.`,
    );
  }
}
