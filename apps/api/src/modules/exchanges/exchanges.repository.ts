import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { PrismaService } from '../../prisma/prisma.service';

/** What every read of an exchange carries, so callers never re-query the legs. */
export const exchangeWithLegs = {
  return: { include: { items: true } },
  replacementSale: { include: { items: true } },
  originalSale: { select: { id: true, saleNumber: true } },
} satisfies Prisma.ExchangeInclude;

export type ExchangeWithLegs = Prisma.ExchangeGetPayload<{ include: typeof exchangeWithLegs }>;

/**
 * Data access for `Exchange` (D107).
 *
 * Deliberately thin: an exchange owns no lines and no money of its own, so there
 * is very little here. Everything substantive lives in the Return and Sale
 * repositories, which is the point of the record.
 */
@Injectable()
export class ExchangesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.prisma.exchange.findFirst({
      where: { tenantId, idempotencyKey },
      include: exchangeWithLegs,
    });
  }

  findById(tenantId: string, id: string) {
    return this.prisma.exchange.findFirst({
      where: { id, tenantId },
      include: exchangeWithLegs,
    });
  }

  listForTenant(tenantId: string, take: number) {
    return this.prisma.exchange.findMany({
      where: { tenantId },
      include: exchangeWithLegs,
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * `X-000042`, matching `R-` and `S-`.
   *
   * Its own `DocumentSequence` type so an exchange number can never collide with
   * the sale or return it links. Gaps are accepted on the same terms as every
   * other document type (D104b).
   */
  async nextExchangeNumber(tenantId: string): Promise<string> {
    return `X-${padSequence(await nextDocumentNumber(this.prisma, tenantId, 'EXCHANGE'))}`;
  }

  create(data: {
    tenantId: string;
    branchId: string;
    exchangeNumber: string;
    originalSaleId: string;
    returnId: string;
    createdByUserId: string;
    idempotencyKey: string | null;
  }) {
    // `replacementSaleId` is deliberately absent: the return leg has committed
    // and the sale has not been attempted yet. That interval is the recoverable
    // state D107 chose, and the row has to be able to express it.
    return this.prisma.exchange.create({ data, include: exchangeWithLegs });
  }

  attachReplacementSale(id: string, replacementSaleId: string) {
    return this.prisma.exchange.update({
      where: { id },
      data: { replacementSaleId },
      include: exchangeWithLegs,
    });
  }
}
