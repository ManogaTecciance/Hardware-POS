import { Injectable } from '@nestjs/common';
import {
  DeliveryPlatformKind,
  ExternalOrderStatus,
  RestaurantOrderChannel,
  RestaurantOrderStatus,
  TakeawayOrderStatus,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The unified UI-facing lifecycle status the Orders screen shows on
 * every row, regardless of channel. Derivation table lives in
 * `unifiedStatusFor(...)` below and matches Section 3.1 of the Pilot
 * Change 2 design plan.
 */
export type UnifiedOrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'READY'
  | 'HANDED_OVER'
  | 'COMPLETED'
  | 'CANCELLED';

export type UnifiedChannel = 'DINE_IN' | 'TAKEAWAY' | 'THIRD_PARTY';

export type UnifiedSource =
  | 'POS'
  | 'WALK_IN'
  | 'PHONE_ORDER'
  | 'UBER_EATS'
  | 'PICKME_FOOD'
  | 'DOORDASH'
  | 'MOCK'
  | 'OTHER';

export interface OrderView {
  /** Row id — stable per channel. For 3rd-party rows this is the ExternalOrder id. */
  id: string;
  channel: UnifiedChannel;
  source: UnifiedSource;
  orderNumber: string;
  unifiedStatus: UnifiedOrderStatus;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Table code for dine-in, pickup label for takeaway, external ref for 3rd party. */
  contextLabel: string | null;
  pickupAt: string | null;
  createdAt: string;
  total: string | null;
  /**
   * D83 — the settled Sale behind this row, when there is one.
   *
   * The queue already resolves the sale to read its total and payment
   * status; withholding the id meant the Orders page could show what a table
   * owed but not open or reprint the bill, which is the one thing anybody
   * looking at a closed order wants to do.
   */
  saleId: string | null;
  itemCount: number;
  itemPreview: { name: string; qty: number }[];
}

export interface OrdersQuery {
  channel?: UnifiedChannel | 'ALL';
  status?: UnifiedOrderStatus | 'ALL';
  paymentStatus?: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'ALL';
  from?: Date;
  to?: Date;
  /** Substring match on orderNumber, customerName, customerPhone, contextLabel. */
  search?: string;
  /** 1-based. Out-of-range pages return an empty page, not an error. */
  page?: number;
  pageSize?: number;
}

export interface OrdersPage {
  items: OrderView[];
  /** Rows matching the filter across every page. */
  total: number;
  page: number;
  pageSize: number;
  /**
   * The scan hit {@link SCAN_CEILING}, so `total` is a floor rather than the
   * true count and later pages may be incomplete.
   *
   * Surfaced rather than hidden: the alternative is a list that silently stops,
   * which is the defect this endpoint had before it was paged at all.
   */
  truncated: boolean;
  /**
   * How many rows each status holds, for the tab row above the list.
   *
   * Counted BEFORE the status filter and across every page, so the tabs keep
   * showing the whole picture while one of them is selected. Deriving them from
   * the returned rows cannot work once the list is paged — the count would be
   * "on this page", and would read as the total.
   */
  statusCounts: Record<UnifiedOrderStatus, number>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * How many rows per source the scan will pull before paging.
 *
 * `unifiedStatus` and `paymentStatus` are DERIVED — from the order status, its
 * round statuses and any takeaway profile — and search spans joined columns, so
 * those filters cannot be pushed into the `where`. Expressing them in SQL would
 * fork the derivation that `unifiedStatusForRestaurantOrder` owns and is tested
 * on, and the two copies would drift.
 *
 * So the scan applies every filter SQL can express (tenant, branch, channel,
 * date), derives the rest in TypeScript, and pages the result. The ceiling is
 * what keeps that bounded; crossing it sets `truncated` so the operator is told
 * to narrow the window instead of being handed a quietly short list.
 */
const SCAN_CEILING = 1000;

@Injectable()
export class RestaurantOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Unified list of every order on the branch — dine-in RestaurantOrder
   * rows, takeaway RestaurantOrder rows (with their TakeawayOrderProfile
   * for status + pickup) and ExternalOrder rows for 3rd-party. Filters
   * apply server-side so the client never merges heterogeneous shapes.
   *
   * `limit` defaults to 100 — enough for a full service shift on a small
   * to medium pilot restaurant, and low enough that a runaway paging
   * request cannot exhaust memory. A separate paginated endpoint is a
   * post-pilot follow-up.
   */
  async listOrders(
    tenantId: string,
    branchId: string,
    query: OrdersQuery = {},
  ): Promise<OrdersPage> {
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(query.page ?? 1, 1);
    // One row beyond the ceiling, purely so a full scan can be told from one
    // that was cut off. The extra row is dropped before paging.
    const scan = SCAN_CEILING + 1;
    const channel = query.channel ?? 'ALL';
    const status = query.status ?? 'ALL';
    const payment = query.paymentStatus ?? 'ALL';
    const dateWhere =
      query.from || query.to
        ? { gte: query.from ?? undefined, lte: query.to ?? undefined }
        : undefined;

    const includeRestaurant = channel === 'ALL' || channel === 'DINE_IN' || channel === 'TAKEAWAY';
    const includeExternal = channel === 'ALL' || channel === 'THIRD_PARTY';

    const rows: OrderView[] = [];

    if (includeRestaurant) {
      const restaurant = await this.prisma.restaurantOrder.findMany({
        where: {
          tenantId,
          branchId,
          ...(channel === 'DINE_IN' ? { channel: 'DINE_IN' } : channel === 'TAKEAWAY' ? { channel: 'TAKEAWAY' } : {}),
          ...(dateWhere ? { createdAt: dateWhere } : {}),
        },
        take: scan,
        orderBy: { createdAt: 'desc' },
        include: {
          session: {
            include: { table: { select: { code: true, label: true } } },
          },
          items: {
            where: { status: { not: 'VOIDED' } },
            orderBy: { createdAt: 'asc' },
            select: { menuItemName: true, quantity: true },
          },
          rounds: {
            select: { status: true },
          },
          takeawayProfile: {
            select: {
              status: true,
              customerName: true,
              customerPhone: true,
              pickupAt: true,
            },
          },
        },
      });

      // For payment status, join Sale via finalSaleId on TableSession.
      const saleIds = restaurant
        .map((o) => o.session?.finalSaleId)
        .filter((s): s is string => !!s);
      const sales = saleIds.length
        ? await this.prisma.sale.findMany({
            where: { id: { in: saleIds } },
            select: { id: true, paymentStatus: true, total: true },
          })
        : [];
      const saleById = new Map(sales.map((s) => [s.id, s]));

      for (const o of restaurant) {
        const isTakeaway = o.channel === 'TAKEAWAY';
        const sale = o.session?.finalSaleId ? saleById.get(o.session.finalSaleId) : null;
        const unified = unifiedStatusForRestaurantOrder({
          orderStatus: o.status,
          roundStatuses: o.rounds.map((r) => r.status),
          takeawayStatus: o.takeawayProfile?.status ?? null,
        });
        const source: UnifiedSource = isTakeaway
          ? o.takeawayProfile?.customerPhone
            ? 'PHONE_ORDER'
            : o.takeawayProfile?.customerName
              ? 'POS'
              : 'WALK_IN'
          : 'POS';

        const contextLabel = isTakeaway
          ? o.takeawayProfile?.customerName ?? 'Walk-in'
          : o.session?.table
            ? o.session.table.label ?? o.session.table.code
            : null;

        rows.push({
          id: o.id,
          channel: isTakeaway ? 'TAKEAWAY' : 'DINE_IN',
          source,
          orderNumber: o.orderNumber,
          unifiedStatus: unified,
          paymentStatus: sale?.paymentStatus ?? null,
          customerName: o.takeawayProfile?.customerName ?? null,
          customerPhone: o.takeawayProfile?.customerPhone ?? null,
          contextLabel,
          pickupAt: o.takeawayProfile?.pickupAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
          total: sale?.total?.toFixed(2) ?? null,
          saleId: sale?.id ?? null,
          itemCount: o.items.reduce((s, i) => s + Number(i.quantity), 0),
          itemPreview: o.items.slice(0, 3).map((i) => ({
            name: i.menuItemName,
            qty: Number(i.quantity),
          })),
        });
      }
    }

    if (includeExternal) {
      const external = await this.prisma.externalOrder.findMany({
        where: {
          tenantId,
          branchId,
          ...(dateWhere ? { receivedAt: dateWhere } : {}),
        },
        take: scan,
        orderBy: { receivedAt: 'desc' },
        include: { platform: { select: { kind: true } } },
      });
      for (const e of external) {
        rows.push({
          id: e.id,
          channel: 'THIRD_PARTY',
          source: platformToSource(e.platform.kind),
          orderNumber: e.externalOrderRef,
          unifiedStatus: unifiedStatusForExternalOrder(e.status),
          // Payment status for 3rd party lives on the platform side; the
          // MOCK adapter does not surface it, so we return null and the
          // UI shows "—".
          paymentStatus: null,
          customerName: null,
          customerPhone: null,
          contextLabel: e.externalOrderRef,
          pickupAt: null,
          createdAt: e.receivedAt.toISOString(),
          total: e.externalTotal?.toFixed(2) ?? null,
          // A third-party order settles on the partner's side; there is no
          // Sale of ours to open.
          saleId: null,
          // ExternalOrder does not persist a per-item breakdown in this
          // schema; the UI shows the total as the only summary.
          itemCount: 0,
          itemPreview: [],
        });
      }
    }

    // Apply the unified-status filter after derivation. Doing it before
    // would require six branching where-clauses per channel, which is
    // significantly harder to test and no faster in practice for pilot
    // volume.
    let base = rows;
    if (payment !== 'ALL') {
      base = base.filter((r) => r.paymentStatus === payment);
    }
    if (query.search) {
      const q = query.search.trim().toLowerCase();
      base = base.filter(
        (r) =>
          r.orderNumber.toLowerCase().includes(q) ||
          (r.customerName ?? '').toLowerCase().includes(q) ||
          (r.customerPhone ?? '').toLowerCase().includes(q) ||
          (r.contextLabel ?? '').toLowerCase().includes(q),
      );
    }

    // Tallied on `base` — every filter EXCEPT status — so selecting one tab
    // does not zero the others.
    const statusCounts = emptyStatusCounts();
    for (const r of base) statusCounts[r.unifiedStatus] += 1;

    const filtered = status === 'ALL' ? base : base.filter((r) => r.unifiedStatus === status);

    /*
     * Sorted newest first across channels BEFORE paging, so page 2 continues
     * page 1 rather than resuming whichever source happened to be appended
     * second. Ties break on id, so two orders created in the same millisecond
     * cannot swap places between two requests and be shown twice or not at all.
     */
    const sorted = filtered.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });

    const truncated = rows.length > SCAN_CEILING;
    const start = (page - 1) * pageSize;
    return {
      // A page past the end is an empty page, not an error: filters change
      // under a reader who is on page 4, and a 404 there reads as a fault.
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
      truncated,
      statusCounts,
    };
  }
}

/** Every status at zero, so a status absent from the page still has a count. */
function emptyStatusCounts(): Record<UnifiedOrderStatus, number> {
  return {
    DRAFT: 0,
    PENDING: 0,
    CONFIRMED: 0,
    IN_PROGRESS: 0,
    READY: 0,
    HANDED_OVER: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };
}

/**
 * Pure derivation from the underlying enums to the unified status the UI
 * shows. Exported for a future unit test — no I/O.
 */
export function unifiedStatusForRestaurantOrder(input: {
  orderStatus: RestaurantOrderStatus;
  roundStatuses: readonly string[];
  takeawayStatus: TakeawayOrderStatus | null;
}): UnifiedOrderStatus {
  if (input.takeawayStatus) {
    switch (input.takeawayStatus) {
      case 'PLACED':
        return 'PENDING';
      case 'IN_KITCHEN':
        return 'IN_PROGRESS';
      case 'READY':
        return 'READY';
      case 'HANDED_OVER':
        return 'HANDED_OVER';
      case 'CANCELLED':
        return 'CANCELLED';
    }
  }
  if (input.orderStatus === 'CANCELLED') return 'CANCELLED';
  if (input.orderStatus === 'COMPLETED') return 'COMPLETED';
  if (input.orderStatus === 'DRAFT') return 'DRAFT';
  // SUBMITTED / PARTIAL — derive from round status.
  const rs = input.roundStatuses;
  if (rs.length === 0) return 'PENDING';
  if (rs.every((s) => s === 'READY' || s === 'DELIVERED')) return 'READY';
  if (rs.some((s) => s === 'IN_PROGRESS' || s === 'READY' || s === 'DELIVERED')) return 'IN_PROGRESS';
  return 'PENDING';
}

export function unifiedStatusForExternalOrder(status: ExternalOrderStatus): UnifiedOrderStatus {
  switch (status) {
    case 'PENDING':
      return 'PENDING';
    case 'ACCEPTED':
      return 'CONFIRMED';
    case 'IN_KITCHEN':
      return 'IN_PROGRESS';
    case 'READY':
      return 'READY';
    case 'DELIVERED':
      return 'HANDED_OVER';
    case 'REJECTED':
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

function platformToSource(kind: DeliveryPlatformKind): UnifiedSource {
  switch (kind) {
    case 'UBER_EATS':
      return 'UBER_EATS';
    case 'PICKME_FOOD':
      return 'PICKME_FOOD';
    case 'DOORDASH':
      return 'DOORDASH';
    case 'MOCK':
      return 'MOCK';
    default:
      return 'OTHER';
  }
}

// Re-export for tests that want to spot-check the discriminated channel type.
export { RestaurantOrderChannel };
