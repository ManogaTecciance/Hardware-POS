import { Controller, Get, Param, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import {
  OrderView,
  OrdersPage,
  OrdersQuery,
  RestaurantOrdersService,
  UnifiedChannel,
  UnifiedOrderStatus,
} from './restaurant-orders.service';

/**
 * Unified read-model for the Orders screen (Pilot Change 2 Slice D).
 *
 * Purely additive over existing per-channel endpoints — nothing else
 * moves. Gated on TABLE_VIEW, which every operational restaurant role
 * already holds; TABLE_MANAGEMENT module gate matches the /tables
 * family so a hardware tenant cannot reach this.
 */
@Controller('restaurant')
@RequireModule(ModuleKey.TABLE_MANAGEMENT)
export class RestaurantOrdersController {
  constructor(private readonly service: RestaurantOrdersService) {}

  @Get('branches/:branchId/orders')
  @RequirePermissions(Permission.TABLE_VIEW)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<OrdersPage> {
    const q: OrdersQuery = {
      channel: parseChannel(channel),
      status: parseStatus(status),
      paymentStatus: parsePayment(paymentStatus),
      search: search ?? undefined,
      from: parseDate(from),
      to: parseDate(to),
      // `Number('abc')` is NaN, which would sail past a plain `? :` and reach
      // the service as a page number that breaks the slice. Anything that is
      // not a finite number is treated as absent, so the default applies.
      page: toPositiveInt(page),
      pageSize: toPositiveInt(pageSize),
    };
    return this.service.listOrders(tenantId, branchId, q);
  }
}

/** A query-string integer, or `undefined` for anything that is not one. */
function toPositiveInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseChannel(v: string | undefined): UnifiedChannel | 'ALL' {
  return v === 'DINE_IN' || v === 'TAKEAWAY' || v === 'THIRD_PARTY' ? v : 'ALL';
}
const STATUSES: UnifiedOrderStatus[] = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'IN_PROGRESS',
  'READY',
  'HANDED_OVER',
  'COMPLETED',
  'CANCELLED',
];
function parseStatus(v: string | undefined): UnifiedOrderStatus | 'ALL' {
  return v && (STATUSES as string[]).includes(v) ? (v as UnifiedOrderStatus) : 'ALL';
}
function parsePayment(v: string | undefined) {
  return v === 'UNPAID' || v === 'PARTIAL' || v === 'PAID' || v === 'REFUNDED' ? v : 'ALL';
}
function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
