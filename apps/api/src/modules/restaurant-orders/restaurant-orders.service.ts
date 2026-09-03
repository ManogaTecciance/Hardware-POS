import { Injectable } from '@nestjs/common';
import {
  DeliveryPlatformKind,
  ExternalOrderStatus,
  Prisma,
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

/** One priced line on the order detail — snapshots, never live menu prices. */
export interface OrderDetailItemView {
  name: string;
  variantName: string | null;
  quantity: string;
  unitPrice: string;
  modifierTotal: string;
  /** (unitPrice + modifierTotal) × quantity, in Decimal arithmetic. */
  lineTotal: string;
  specialInstructions: string | null;
  modifiers: { optionName: string; groupName: string; priceDelta: string }[];
}

/**
 * The full record behind one Orders-screen row, fetched when the operator
 * opens the drawer. Kept OFF the polled list on purpose: the queue refetches
 * every 8 s and does not need line items, payments or a timeline riding on
 * every row of every poll.
 */
export interface OrderDetailView extends OrderView {
  /**
   * Delivery destination for a counter delivery order. The schema has no
   * address column yet — the counter POS stores it in
   * `TakeawayOrderProfile.notes` with a `[Delivery]` prefix (see
   * payment-popup.tsx), and this endpoint is where that workaround is parsed
   * back out so the queue shows a destination, not a notes convention.
   */
  deliveryAddress: string | null;
  /** Operator notes with the `[Delivery]` piece removed; null when empty. */
  notes: string | null;
  items: OrderDetailItemView[];
  /** Settled-Sale money breakdown; null while there is no Sale (open order, 3rd-party). */
  financials: {
    subtotal: string;
    totalDiscount: string;
    serviceChargeAmount: string;
    packagingCharge: string;
    taxAmount: string;
    total: string;
    paidAmount: string;
    balanceAmount: string;
  } | null;
  payments: { method: string; amount: string; reference: string | null; at: string }[];
  /**
   * Status transitions in the unified vocabulary, oldest first. Built from
   * what is already recorded — RestaurantOrderStatusHistory, the takeaway
   * profile's handover timestamp, ExternalOrderEvent rows — so channels
   * differ in how much history they can show.
   */
  timeline: { at: string; status: UnifiedOrderStatus }[];
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
        const sale = o.session?.finalSaleId ? saleById.get(o.session.finalSaleId) ?? null : null;
        rows.push(restaurantOrderBaseView(o, sale));
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
        rows.push(externalOrderBaseView(e));
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

  /**
   * The full record behind one queue row, for the drawer. The row id is
   * channel-typed at the source — a RestaurantOrder id for dine-in/takeaway,
   * an ExternalOrder id for 3rd-party — so the lookup tries the restaurant
   * table first and falls through to external. Null (not 404) for an unknown
   * id: the queue polls under the open drawer, and a row that was archived
   * mid-look should degrade to the row data, not to an error screen.
   */
  async getOrderDetail(
    tenantId: string,
    branchId: string,
    orderId: string,
  ): Promise<OrderDetailView | null> {
    const o = await this.prisma.restaurantOrder.findFirst({
      where: { id: orderId, tenantId, branchId },
      include: {
        session: { include: { table: { select: { code: true, label: true } } } },
        items: {
          where: { status: { not: 'VOIDED' } },
          orderBy: { createdAt: 'asc' },
          include: {
            modifiers: { select: { optionName: true, groupName: true, priceDelta: true } },
          },
        },
        rounds: { select: { status: true } },
        takeawayProfile: true,
      },
    });

    if (o) {
      const sale = o.session?.finalSaleId
        ? await this.prisma.sale.findFirst({
            where: { id: o.session.finalSaleId, tenantId },
            include: { payments: { orderBy: { createdAt: 'asc' } } },
          })
        : null;
      const history = await this.prisma.restaurantOrderStatusHistory.findMany({
        where: { tenantId, orderId: o.id },
        orderBy: { createdAt: 'asc' },
      });

      const timeline = history.map((h) => ({
        at: h.createdAt.toISOString(),
        status: coarseUnifiedForOrderStatus(h.toStatus),
      }));
      // Takeaway transitions are not written to the history table; the
      // handover instant is the one the profile does record, so it joins the
      // timeline from there rather than being invented.
      if (o.takeawayProfile?.handoverAt) {
        timeline.push({
          at: o.takeawayProfile.handoverAt.toISOString(),
          status: 'HANDED_OVER' as const,
        });
      }
      timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

      const { deliveryAddress, notes } = splitDeliveryNotes(o.takeawayProfile?.notes ?? null);

      return {
        ...restaurantOrderBaseView(o, sale),
        deliveryAddress,
        notes,
        items: o.items.map((i) => ({
          name: i.menuItemName,
          variantName: i.variantNameSnapshot ?? null,
          quantity: i.quantity.toString(),
          unitPrice: i.unitPrice.toFixed(2),
          modifierTotal: i.modifierTotal.toFixed(2),
          lineTotal: i.unitPrice.plus(i.modifierTotal).times(i.quantity).toFixed(2),
          specialInstructions: i.specialInstructions ?? null,
          modifiers: i.modifiers.map((m) => ({
            optionName: m.optionName,
            groupName: m.groupName,
            priceDelta: m.priceDelta.toFixed(2),
          })),
        })),
        financials: sale
          ? {
              subtotal: sale.subtotal.toFixed(2),
              totalDiscount: sale.totalDiscount.toFixed(2),
              serviceChargeAmount: sale.serviceChargeAmount.toFixed(2),
              packagingCharge: sale.packagingCharge.toFixed(2),
              taxAmount: sale.taxAmount.toFixed(2),
              total: sale.total.toFixed(2),
              paidAmount: sale.paidAmount.toFixed(2),
              balanceAmount: sale.balanceAmount.toFixed(2),
            }
          : null,
        payments: (sale?.payments ?? []).map((p) => ({
          method: p.method,
          amount: p.amount.toFixed(2),
          reference: p.reference ?? null,
          at: p.createdAt.toISOString(),
        })),
        timeline,
      };
    }

    const e = await this.prisma.externalOrder.findFirst({
      where: { id: orderId, tenantId, branchId },
      include: {
        platform: { select: { kind: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!e) return null;
    return {
      ...externalOrderBaseView(e),
      deliveryAddress: null,
      notes: null,
      items: [],
      financials: null,
      payments: [],
      timeline: e.events.map((ev) => ({
        at: ev.createdAt.toISOString(),
        status: unifiedStatusForExternalOrder(ev.toStatus),
      })),
    };
  }
}

/**
 * The queue-row projection of a RestaurantOrder, shared by the list scan and
 * the detail endpoint so the two cannot drift on source/context/status
 * derivation. `quantity` is `Prisma.Decimal | number` because the paging spec
 * stubs rows with plain numbers.
 */
function restaurantOrderBaseView(
  o: {
    id: string;
    channel: RestaurantOrderChannel;
    orderNumber: string;
    status: RestaurantOrderStatus;
    createdAt: Date;
    rounds: { status: string }[];
    session: { table: { code: string; label: string | null } | null } | null;
    takeawayProfile: {
      status: TakeawayOrderStatus;
      customerName: string | null;
      customerPhone: string | null;
      pickupAt: Date | null;
    } | null;
    items: { menuItemName: string; quantity: Prisma.Decimal | number }[];
  },
  sale: {
    id: string;
    paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';
    total: Prisma.Decimal | null;
  } | null,
): OrderView {
  const isTakeaway = o.channel === 'TAKEAWAY';
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

  return {
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
  };
}

/** The queue-row projection of an ExternalOrder — see restaurantOrderBaseView. */
function externalOrderBaseView(e: {
  id: string;
  externalOrderRef: string;
  status: ExternalOrderStatus;
  receivedAt: Date;
  externalTotal: Prisma.Decimal | null;
  platform: { kind: DeliveryPlatformKind };
}): OrderView {
  return {
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
  };
}

/**
 * Order-SHELL transitions only, for the detail timeline. Coarser than
 * `unifiedStatusForRestaurantOrder` on purpose: a history row records the
 * RestaurantOrderStatus that changed, without the round/takeaway context the
 * live derivation reads, so each shell status maps to the nearest unified
 * entry rather than pretending to know the kitchen state at that instant.
 */
function coarseUnifiedForOrderStatus(s: RestaurantOrderStatus): UnifiedOrderStatus {
  switch (s) {
    case 'DRAFT':
      return 'DRAFT';
    case 'SUBMITTED':
      return 'PENDING';
    case 'PARTIAL':
      return 'IN_PROGRESS';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

/**
 * Undo the counter POS's address workaround: no address column exists, so
 * payment-popup.tsx stores the destination in `TakeawayOrderProfile.notes` as
 * a `[Delivery] <address>` piece (' · '-joined with any other pieces, address
 * last). Parsed HERE, once, so no client ever string-matches notes itself —
 * when a real column lands, this function is the only thing that changes.
 */
function splitDeliveryNotes(notes: string | null): {
  deliveryAddress: string | null;
  notes: string | null;
} {
  if (!notes) return { deliveryAddress: null, notes: null };
  const marker = '[Delivery] ';
  const ix = notes.indexOf(marker);
  if (ix === -1) return { deliveryAddress: null, notes };
  const deliveryAddress = notes.slice(ix + marker.length).trim();
  const rest = notes
    .slice(0, ix)
    .replace(/\s*·\s*$/, '')
    .trim();
  return { deliveryAddress: deliveryAddress || null, notes: rest || null };
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
