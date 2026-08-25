import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdateRestaurantBranchConfigDto } from './dto/restaurant-config.dto';
import {
  BranchNotFoundError,
  ConfigVersionConflictError,
} from './restaurant.errors';

export interface RestaurantBranchConfigView {
  branchId: string;
  serviceChargePercent: string;
  takeawayEnabled: boolean;
  dineInEnabled: boolean;
  defaultTicketTargetMinutes: number | null;
  /** D52 — which channels levy the service charge. */
  serviceChargeChannels: string[];
  /** D52 — whether the service charge sits inside the taxable base. */
  serviceChargeTaxable: boolean;
  /** D52 — flat per-order packaging charge for TAKEAWAY / ONLINE. */
  packagingChargeAmount: string;
  version: number;
  updatedAt: string;
}

const CODE_DEFAULTS = {
  serviceChargePercent: '0.00',
  /*
   * D97 — TRUE, and it has to be: `TakeawayService.create` refuses only when a
   * row exists and says false, so an unconfigured branch takes takeaway orders.
   * Reporting `false` here described a restriction the server does not apply,
   * and the Charges tab believed it.
   */
  takeawayEnabled: true,
  dineInEnabled: true,
  defaultTicketTargetMinutes: null,
  serviceChargeChannels: ['DINE_IN'],
  serviceChargeTaxable: true,
  packagingChargeAmount: '0.00',
  version: 0,
};

@Injectable()
export class RestaurantConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the current configuration. A branch with no row resolves to the
   * documented defaults — that is a valid state, not a missing row. The
   * response's `version` is `0` for the unconfigured case so a subsequent
   * PUT can pass `expectedVersion: 0` and race-detect against a concurrent
   * insert.
   */
  async get(tenantId: string, branchId: string): Promise<RestaurantBranchConfigView> {
    await this.assertBranch(tenantId, branchId);
    const row = await this.prisma.restaurantBranchConfig.findUnique({
      where: { branchId },
    });
    if (!row) {
      return { branchId, ...CODE_DEFAULTS, updatedAt: new Date(0).toISOString() };
    }
    return this.toView(row);
  }

  async update(
    tenantId: string,
    branchId: string,
    dto: UpdateRestaurantBranchConfigDto,
  ): Promise<RestaurantBranchConfigView> {
    await this.assertBranch(tenantId, branchId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.restaurantBranchConfig.findUnique({ where: { branchId } });
      if (existing) {
        if (dto.expectedVersion !== undefined && dto.expectedVersion !== existing.version) {
          throw new ConfigVersionConflictError();
        }
        const updated = await tx.restaurantBranchConfig.update({
          where: { branchId },
          data: {
            serviceChargePercent:
              dto.serviceChargePercent !== undefined
                ? new Prisma.Decimal(dto.serviceChargePercent)
                : undefined,
            takeawayEnabled: dto.takeawayEnabled ?? undefined,
            dineInEnabled: dto.dineInEnabled ?? undefined,
            defaultTicketTargetMinutes:
              dto.defaultTicketTargetMinutes !== undefined
                ? dto.defaultTicketTargetMinutes
                : undefined,
            // D52 — per-channel service charge, taxable base, packaging.
            serviceChargeChannels:
              dto.serviceChargeChannels !== undefined
                ? (dto.serviceChargeChannels as never)
                : undefined,
            serviceChargeTaxable:
              dto.serviceChargeTaxable !== undefined ? dto.serviceChargeTaxable : undefined,
            packagingChargeAmount:
              dto.packagingChargeAmount !== undefined
                ? new Prisma.Decimal(dto.packagingChargeAmount)
                : undefined,
            version: { increment: 1 },
          },
        });
        return this.toView(updated);
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        // Caller claimed a specific version but there's no row — someone else
        // deleted it, or the client's cache is stale.
        throw new ConfigVersionConflictError();
      }
      const created = await tx.restaurantBranchConfig.create({
        data: {
          tenantId,
          branchId,
          serviceChargePercent: new Prisma.Decimal(dto.serviceChargePercent ?? 0),
          /*
           * D97 — `?? true`, not `?? false`. This create path runs the first
           * time anybody saves ANY branch setting, and the Charges tab does not
           * send these two: setting a service charge was therefore switching
           * takeaway off, and every takeaway order after it failed with
           * "Takeaway is disabled on this branch". A create must not decide
           * something the caller never mentioned — `dineInEnabled` already had
           * this right, which is why dine-in never broke the same way.
           */
          takeawayEnabled: dto.takeawayEnabled ?? true,
          dineInEnabled: dto.dineInEnabled ?? true,
          defaultTicketTargetMinutes: dto.defaultTicketTargetMinutes ?? null,
          ...(dto.serviceChargeChannels !== undefined
            ? { serviceChargeChannels: dto.serviceChargeChannels as never }
            : {}),
          ...(dto.serviceChargeTaxable !== undefined
            ? { serviceChargeTaxable: dto.serviceChargeTaxable }
            : {}),
          ...(dto.packagingChargeAmount !== undefined
            ? { packagingChargeAmount: dto.packagingChargeAmount }
            : {}),
        },
      });
      return this.toView(created);
    });
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) {
      // Foreign or deactivated branches answer 404, not 403 — no existence oracle.
      throw new BranchNotFoundError();
    }
  }

  private toView(
    row: Prisma.RestaurantBranchConfigGetPayload<Record<string, never>>,
  ): RestaurantBranchConfigView {
    return {
      branchId: row.branchId,
      serviceChargePercent: row.serviceChargePercent.toFixed(2),
      takeawayEnabled: row.takeawayEnabled,
      dineInEnabled: row.dineInEnabled,
      defaultTicketTargetMinutes: row.defaultTicketTargetMinutes,
      serviceChargeChannels: row.serviceChargeChannels,
      serviceChargeTaxable: row.serviceChargeTaxable,
      packagingChargeAmount: row.packagingChargeAmount.toFixed(2),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
