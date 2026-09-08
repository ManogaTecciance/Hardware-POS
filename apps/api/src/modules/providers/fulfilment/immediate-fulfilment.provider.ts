import { Injectable } from '@nestjs/common';
import { FulfilmentKind, Prisma } from '@hardware-pos/database';

import type { ProjectedSaleItem } from '../../restaurant/settlement-projection';
import type { FulfilmentProvider, ReleaseOutcome, WorkUnitRef } from './fulfilment-provider';

/**
 * D61 — immediate fulfilment: the counter sale.
 *
 * Deliberately thin, and honestly so. A counter sale has no persisted work
 * unit — the priced cart in the request IS the work unit (plan §3.3 rejected
 * inventing an order row for it), so collection is a pass-through of the
 * cart's lines and release holds nothing to free. The class exists because
 * the kind must be total: `FULFILMENT_PROVIDERS` is a `Record<FulfilmentKind,
 * …>`, and a kind without a provider is a compile error — the same
 * no-silent-fallback rule the domain registry uses (D56).
 */
@Injectable()
export class ImmediateFulfilmentProvider implements FulfilmentProvider {
  readonly kind = FulfilmentKind.IMMEDIATE;

  async collectSettlementLines(
    _tx: Prisma.TransactionClient,
    _tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ProjectedSaleItem[]> {
    if (ref.kind !== 'CART') {
      throw new Error(`ImmediateFulfilmentProvider cannot settle a ${ref.kind} work unit`);
    }
    return ref.lines;
  }

  async releaseResources(
    _tx: Prisma.TransactionClient,
    _tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ReleaseOutcome> {
    if (ref.kind !== 'CART') {
      throw new Error(`ImmediateFulfilmentProvider cannot release a ${ref.kind} work unit`);
    }
    return {};
  }
}
