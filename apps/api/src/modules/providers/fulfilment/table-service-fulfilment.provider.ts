import { Injectable } from '@nestjs/common';
import {
  FulfilmentKind,
  Prisma,
  RestaurantOrderItemStatus,
  RestaurantTableKind,
  RestaurantTableStatus,
} from '@hardware-pos/database';

import { DiningService } from '../../dining/dining.service';
import {
  projectOrderItems,
  type ProjectedSaleItem,
} from '../../restaurant/settlement-projection';
import type { FulfilmentProvider, ReleaseOutcome, WorkUnitRef } from './fulfilment-provider';

/**
 * D61 — table service: the session → order → rounds lifecycle settles here.
 *
 * Collection reads the SAME rows the bill was computed from (non-voided
 * order items with their frozen modifier snapshots) and runs them through
 * D58's projection — one mapping for the live close, the backfill and this
 * provider, so they cannot drift. Release is the logic that lived inline in
 * `closeSession`: physical tables go AVAILABLE; an open table (D49/D50)
 * dissolves the whole arrangement in the settlement transaction.
 */
@Injectable()
export class TableServiceFulfilmentProvider implements FulfilmentProvider {
  readonly kind = FulfilmentKind.TABLE_SERVICE;

  constructor(private readonly dining: DiningService) {}

  async collectSettlementLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ProjectedSaleItem[]> {
    if (ref.kind !== 'TABLE_SESSION') {
      throw new Error(`TableServiceFulfilmentProvider cannot settle a ${ref.kind} work unit`);
    }
    const items = await tx.restaurantOrderItem.findMany({
      where: {
        tenantId,
        order: { sessionId: ref.sessionId },
        status: { not: RestaurantOrderItemStatus.VOIDED },
      },
      include: { modifiers: true },
    });
    return projectOrderItems(items);
  }

  async releaseResources(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ReleaseOutcome> {
    if (ref.kind !== 'TABLE_SESSION') {
      throw new Error(`TableServiceFulfilmentProvider cannot release a ${ref.kind} work unit`);
    }
    const session = await tx.tableSession.findUniqueOrThrow({
      where: { id: ref.sessionId },
      select: { tableId: true },
    });
    const table = await tx.restaurantTable.findUniqueOrThrow({
      where: { id: session.tableId },
      select: { kind: true },
    });
    if (table.kind === RestaurantTableKind.OPEN) {
      const openTableRelease = await this.dining.releaseOpenTable(tx, tenantId, session.tableId);
      return { openTableRelease };
    }
    await tx.restaurantTable.update({
      where: { id: session.tableId },
      data: { status: RestaurantTableStatus.AVAILABLE },
    });
    return {};
  }
}
