import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryPlatformKind,
  ExternalOrderStatus,
  Prisma,
  RestaurantOrderChannel,
  RestaurantTableStatus,
  TableSessionStatus,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { KitchenService } from '../kitchen/kitchen.service';
import { DeliveryPlatformRegistry } from './delivery-platform-registry';

export interface ExternalOrderView {
  id: string;
  externalOrderRef: string;
  platformKind: DeliveryPlatformKind;
  status: ExternalOrderStatus;
  externalTotal: string | null;
  restaurantOrderId: string | null;
  receivedAt: string;
}

@Injectable()
export class DeliveryHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitchen: KitchenService,
    private readonly registry: DeliveryPlatformRegistry,
  ) {}

  /**
   * The webhook entry point. Called by DeliveryWebhookController for a POST
   * from the platform. Returns the ExternalOrder view; the log row is
   * written unconditionally so a failed accept still leaves an audit trail.
   */
  async receiveOrder(
    tenantId: string,
    platformId: string,
    payload: unknown,
  ): Promise<ExternalOrderView> {
    const platform = await this.prisma.deliveryPlatform.findFirst({
      where: { id: platformId, tenantId, isActive: true },
      select: { id: true, kind: true, branchId: true },
    });
    if (!platform) throw new NotFoundException('Delivery platform not found');

    const adapter = this.registry.get(platform.kind);
    const normalised = adapter.normalizeOrder(payload);

    return this.prisma.$transaction(async (tx) => {
      // Idempotent insert: (platformId, externalOrderRef) is unique.
      const existing = await tx.externalOrder.findUnique({
        where: {
          platformId_externalOrderRef: {
            platformId: platform.id,
            externalOrderRef: normalised.externalOrderRef,
          },
        },
      });
      if (existing) {
        // Duplicate webhook delivery — log it but do not create a new order.
        await tx.webhookDeliveryLog.create({
          data: {
            tenantId,
            branchId: platform.branchId,
            platformId: platform.id,
            payload: normalised.raw,
            responseStatus: 200,
            message: 'duplicate webhook — existing external order returned',
          },
        });
        return this.toView(existing, platform.kind);
      }

      // Create the ExternalOrder + first event.
      const external = await tx.externalOrder.create({
        data: {
          tenantId,
          branchId: platform.branchId,
          platformId: platform.id,
          externalOrderRef: normalised.externalOrderRef,
          externalTotal:
            normalised.externalTotal !== undefined
              ? new Prisma.Decimal(normalised.externalTotal)
              : null,
          status: ExternalOrderStatus.PENDING,
        },
      });
      await tx.externalOrderEvent.create({
        data: {
          tenantId,
          externalOrderId: external.id,
          toStatus: ExternalOrderStatus.PENDING,
          payload: normalised.raw,
        },
      });
      await tx.webhookDeliveryLog.create({
        data: {
          tenantId,
          branchId: platform.branchId,
          platformId: platform.id,
          payload: normalised.raw,
          responseStatus: 201,
          message: `Accepted external order ${normalised.externalOrderRef}`,
        },
      });
      return this.toView(external, platform.kind);
    });
  }

  /**
   * Move an ExternalOrder to ACCEPTED and generate a RestaurantOrder for it
   * (which the kitchen path handles as usual). Items are attached from the
   * original webhook payload — matching to real MenuItem rows is a future
   * concern (kept simple here so the abstraction ships without a menu-match
   * feature attached).
   */
  async acceptExternal(tenantId: string, externalOrderId: string): Promise<ExternalOrderView> {
    return this.prisma.$transaction(async (tx) => {
      const external = await tx.externalOrder.findFirst({
        where: { id: externalOrderId, tenantId },
        include: { platform: true, events: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!external) throw new NotFoundException('External order not found');
      if (external.status !== ExternalOrderStatus.PENDING) {
        // Already handled.
        return this.toView(external, external.platform.kind);
      }

      // Provision a synthetic walk-in seat for the delivery order so the
      // junction to Sale stays unified with dine-in / takeaway.
      const area =
        (await tx.diningArea.findFirst({
          where: { tenantId, branchId: external.branchId, name: '__delivery__' },
          select: { id: true },
        })) ??
        (await tx.diningArea.create({
          data: {
            tenantId,
            branchId: external.branchId,
            name: '__delivery__',
            position: 998,
          },
          select: { id: true },
        }));
      const table =
        (await tx.restaurantTable.findFirst({
          where: { tenantId, branchId: external.branchId, areaId: area.id, code: 'DELIVERY' },
          select: { id: true },
        })) ??
        (await tx.restaurantTable.create({
          data: {
            tenantId,
            branchId: external.branchId,
            areaId: area.id,
            code: 'DELIVERY',
            capacity: 1,
            status: RestaurantTableStatus.AVAILABLE,
          },
          select: { id: true },
        }));

      const sessionSeq = await nextDocumentNumber(tx, tenantId, 'TABLE_SESSION');
      const session = await tx.tableSession.create({
        data: {
          tenantId,
          branchId: external.branchId,
          tableId: table.id,
          sessionNumber: `TS-${padSequence(sessionSeq)}`,
          status: TableSessionStatus.OPEN,
        },
      });
      const orderSeq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
      const restaurantOrder = await tx.restaurantOrder.create({
        data: {
          tenantId,
          branchId: external.branchId,
          sessionId: session.id,
          orderNumber: `RO-${padSequence(orderSeq)}`,
          channel: RestaurantOrderChannel.ONLINE,
          status: 'SUBMITTED',
        },
      });

      await tx.externalOrder.update({
        where: { id: external.id },
        data: {
          status: ExternalOrderStatus.ACCEPTED,
          restaurantOrderId: restaurantOrder.id,
        },
      });
      await tx.externalOrderEvent.create({
        data: {
          tenantId,
          externalOrderId: external.id,
          fromStatus: external.status,
          toStatus: ExternalOrderStatus.ACCEPTED,
        },
      });
      // Fire-and-forget the adapter's platform-side confirmation.
      await this.registry.get(external.platform.kind).acceptOrder(external.externalOrderRef);
      const refreshed = await tx.externalOrder.findUniqueOrThrow({ where: { id: external.id } });
      return this.toView(refreshed, external.platform.kind);
    });
  }

  async listExternalOrders(
    tenantId: string,
    branchId: string,
  ): Promise<ExternalOrderView[]> {
    const rows = await this.prisma.externalOrder.findMany({
      where: { tenantId, branchId },
      include: { platform: { select: { kind: true } } },
      orderBy: { receivedAt: 'desc' },
    });
    return rows.map((r) => this.toView(r, r.platform.kind));
  }

  private toView(
    row: Prisma.ExternalOrderGetPayload<Record<string, never>>,
    kind: DeliveryPlatformKind,
  ): ExternalOrderView {
    return {
      id: row.id,
      externalOrderRef: row.externalOrderRef,
      platformKind: kind,
      status: row.status,
      externalTotal: row.externalTotal?.toFixed(2) ?? null,
      restaurantOrderId: row.restaurantOrderId,
      receivedAt: row.receivedAt.toISOString(),
    };
  }
}
