/**
 * Restaurant API client.
 *
 * Thin wrappers around the shared `api` object; every function corresponds to
 * an audited backend route. The client is grouped by module (menu, dining,
 * sessions, kitchen, takeaway, billing, reports, delivery) so a screen can
 * import the whole namespace and every callable is discoverable.
 *
 * Notes on conventions:
 * - Every call passes `token` + `tenantId` explicitly. The base `api` client
 *   also reads `Authorization` from options, so callers use `authFor(session)`.
 * - `submitRound` and `takeaway.create` require an `idempotencyKey`. Scenario
 *   11 (double-submit) is prevented by the caller generating a stable key per
 *   user intent and passing it in.
 * - The backend returns Decimal-string money fields (`"12.50"`); the client
 *   does not parse them into numbers — they are display strings.
 */

import { api } from '../api';
import type { Session } from '../session-store';
import type {
  BillView,
  ChannelBreakdownRow,
  DiningAreaView,
  ExternalOrderView,
  KitchenPrinterKind,
  KitchenPrinterView,
  KitchenTicketStatus,
  KitchenTicketView,
  MenuItemView,
  MenuView,
  ModifierGroupView,
  OrderItemInput,
  OrderView,
  PaymentBreakdownRow,
  PaymentMethod,
  RestaurantBranchConfigView,
  RestaurantTableView,
  RoundView,
  SalesSummaryView,
  SectionView,
  SessionDetail,
  TableSessionView,
  TakeawayOrderStatus,
  TakeawayView,
  TopMenuItemView,
  UnifiedChannel,
  UnifiedOrderStatus,
  UnifiedOrderView,
  VoidReportRow,
  WaiterPerformanceRow,
} from './types';

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

// ── Restaurant config ──────────────────────────────────────────────────────
export const restaurantConfig = {
  get(session: Session, branchId: string) {
    return api.get<RestaurantBranchConfigView>(
      `/restaurant/branches/${branchId}/config`,
      auth(session),
    );
  },
  update(
    session: Session,
    branchId: string,
    body: {
      serviceChargePercent?: number;
      takeawayEnabled?: boolean;
      dineInEnabled?: boolean;
      defaultTicketTargetMinutes?: number;
      expectedVersion?: number;
    },
  ) {
    return api.put<RestaurantBranchConfigView>(
      `/restaurant/branches/${branchId}/config`,
      body,
      auth(session),
    );
  },
};

// ── Kitchen stations ───────────────────────────────────────────────────────
export const kitchenStations = {
  list(session: Session, branchId: string, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<import('./types').KitchenStationView[]>(
      `/restaurant/branches/${branchId}/kitchen-stations${query}`,
      auth(session),
    );
  },
  create(
    session: Session,
    branchId: string,
    body: { code: string; name: string; category?: string },
  ) {
    return api.post<import('./types').KitchenStationView>(
      `/restaurant/branches/${branchId}/kitchen-stations`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    branchId: string,
    stationId: string,
    body: { name?: string; category?: string; isActive?: boolean },
  ) {
    return api.patch<import('./types').KitchenStationView>(
      `/restaurant/branches/${branchId}/kitchen-stations/${stationId}`,
      body,
      auth(session),
    );
  },
};

// ── Menu ───────────────────────────────────────────────────────────────────
export const menus = {
  list(session: Session, branchId: string, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<MenuView[]>(
      `/restaurant/branches/${branchId}/menus${query}`,
      auth(session),
    );
  },
  create(session: Session, branchId: string, body: { name: string; description?: string }) {
    return api.post<MenuView>(
      `/restaurant/branches/${branchId}/menus`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    branchId: string,
    menuId: string,
    body: {
      name?: string;
      description?: string;
      isActive?: boolean;
      expectedVersion?: number;
    },
  ) {
    return api.patch<MenuView>(
      `/restaurant/branches/${branchId}/menus/${menuId}`,
      body,
      auth(session),
    );
  },
};

export const menuSections = {
  list(session: Session, menuId: string) {
    return api.get<SectionView[]>(`/restaurant/menus/${menuId}/sections`, auth(session));
  },
  create(
    session: Session,
    menuId: string,
    body: { name: string; description?: string; position?: number },
  ) {
    return api.post<SectionView>(
      `/restaurant/menus/${menuId}/sections`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    menuId: string,
    sectionId: string,
    body: {
      name?: string;
      description?: string;
      position?: number;
      isActive?: boolean;
    },
  ) {
    return api.patch<SectionView>(
      `/restaurant/menus/${menuId}/sections/${sectionId}`,
      body,
      auth(session),
    );
  },
};

export const menuItems = {
  list(session: Session, sectionId: string, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<MenuItemView[]>(
      `/restaurant/menu-sections/${sectionId}/items${query}`,
      auth(session),
    );
  },
  create(
    session: Session,
    sectionId: string,
    body: {
      name: string;
      description?: string;
      basePrice: number;
      productId?: string;
      position?: number;
      modifierGroupIds?: string[];
      channelPrices?: { channel: string; price: number }[];
      availability?: { dayOfWeek: string; startTime: string; endTime: string }[];
      stationIds?: string[];
      itemType?: 'FOOD' | 'BEVERAGE' | 'DESSERT';
      prepMinutes?: number;
      dietaryTags?: string[];
      imageUrl?: string;
    },
  ) {
    return api.post<MenuItemView>(
      `/restaurant/menu-sections/${sectionId}/items`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    sectionId: string,
    itemId: string,
    body: Partial<{
      name: string;
      description: string;
      basePrice: number;
      productId: string;
      position: number;
      isActive: boolean;
      modifierGroupIds: string[];
      channelPrices: { channel: string; price: number }[];
      availability: { dayOfWeek: string; startTime: string; endTime: string }[];
      stationIds: string[];
      itemType: 'FOOD' | 'BEVERAGE' | 'DESSERT';
      prepMinutes: number;
      dietaryTags: string[];
      imageUrl: string;
    }>,
  ) {
    return api.patch<MenuItemView>(
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      body,
      auth(session),
    );
  },
};

export const modifierGroups = {
  list(session: Session, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<ModifierGroupView[]>(
      `/restaurant/modifier-groups${query}`,
      auth(session),
    );
  },
  get(session: Session, groupId: string) {
    return api.get<ModifierGroupView>(
      `/restaurant/modifier-groups/${groupId}`,
      auth(session),
    );
  },
  create(
    session: Session,
    body: {
      name: string;
      selection?: 'SINGLE' | 'MULTIPLE';
      minSelections?: number;
      maxSelections?: number;
      options: { name: string; priceDelta?: number; position?: number }[];
      role?: string;
    },
  ) {
    return api.post<ModifierGroupView>(
      `/restaurant/modifier-groups`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    groupId: string,
    body: Partial<{
      name: string;
      selection: 'SINGLE' | 'MULTIPLE';
      minSelections: number;
      maxSelections: number;
      isActive: boolean;
      options: { name: string; priceDelta?: number; position?: number }[];
      role: string;
    }>,
  ) {
    return api.patch<ModifierGroupView>(
      `/restaurant/modifier-groups/${groupId}`,
      body,
      auth(session),
    );
  },
};

// ── Dining ─────────────────────────────────────────────────────────────────
export const diningAreas = {
  list(session: Session, branchId: string, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<DiningAreaView[]>(
      `/restaurant/branches/${branchId}/dining-areas${query}`,
      auth(session),
    );
  },
  create(
    session: Session,
    branchId: string,
    body: { name: string; description?: string; position?: number },
  ) {
    return api.post<DiningAreaView>(
      `/restaurant/branches/${branchId}/dining-areas`,
      body,
      auth(session),
    );
  },
  /**
   * PATCH — creator-scoped (Restaurant Pilot Change 1). Only `name`,
   * `description`, `position` travel; the DTO on the server does not accept
   * `isActive`, which is archive's job (see `archive` below), or `status`
   * (that is not a field on areas). Fields have been narrowed accordingly.
   */
  update(
    session: Session,
    branchId: string,
    areaId: string,
    body: Partial<{ name: string; description: string; position: number }>,
  ) {
    return api.patch<DiningAreaView>(
      `/restaurant/branches/${branchId}/dining-areas/${areaId}`,
      body,
      auth(session),
    );
  },
  archive(session: Session, branchId: string, areaId: string) {
    return api.del<DiningAreaView>(
      `/restaurant/branches/${branchId}/dining-areas/${areaId}`,
      auth(session),
    );
  },
};

export const restaurantTables = {
  list(session: Session, areaId: string, includeArchived = false) {
    const query = includeArchived ? '?includeArchived=true' : '';
    return api.get<RestaurantTableView[]>(
      `/restaurant/dining-areas/${areaId}/tables${query}`,
      auth(session),
    );
  },
  create(
    session: Session,
    areaId: string,
    body: {
      code: string;
      label?: string;
      capacity: number;
      positionX?: number;
      positionY?: number;
    },
  ) {
    return api.post<RestaurantTableView>(
      `/restaurant/dining-areas/${areaId}/tables`,
      body,
      auth(session),
    );
  },
  /**
   * PATCH — creator-scoped. `status` and `isActive` no longer travel through
   * this endpoint (status is set operationally by the sessions system;
   * archive is its own endpoint). `code` is intentionally not editable —
   * it is the shared shorthand callers use out loud.
   */
  update(
    session: Session,
    areaId: string,
    tableId: string,
    body: Partial<{
      label: string;
      capacity: number;
      positionX: number;
      positionY: number;
    }>,
  ) {
    return api.patch<RestaurantTableView>(
      `/restaurant/dining-areas/${areaId}/tables/${tableId}`,
      body,
      auth(session),
    );
  },
  archive(session: Session, areaId: string, tableId: string) {
    return api.del<RestaurantTableView>(
      `/restaurant/dining-areas/${areaId}/tables/${tableId}`,
      auth(session),
    );
  },
};

// ── Table sessions ──────────────────────────────────────────────────────────
export const tableSessions = {
  open(
    session: Session,
    branchId: string,
    body: { tableId: string; guestCount?: number; waiterUserId?: string },
  ) {
    return api.post<TableSessionView>(
      `/restaurant/branches/${branchId}/table-sessions`,
      body,
      auth(session),
    );
  },
  get(session: Session, sessionId: string) {
    return api.get<TableSessionView>(
      `/restaurant/table-sessions/${sessionId}`,
      auth(session),
    );
  },
  listOpen(session: Session, branchId: string) {
    return api.get<(TableSessionView & { activeOrderId: string | null })[]>(
      `/restaurant/branches/${branchId}/open-sessions`,
      auth(session),
    );
  },
  getDetail(session: Session, sessionId: string) {
    return api.get<SessionDetail>(
      `/restaurant/table-sessions/${sessionId}/detail`,
      auth(session),
    );
  },
  createOrder(session: Session, sessionId: string) {
    return api.post<OrderView>(
      `/restaurant/table-sessions/${sessionId}/orders`,
      undefined,
      auth(session),
    );
  },
  submitRound(
    session: Session,
    orderId: string,
    body: { items: OrderItemInput[]; idempotencyKey: string; channel?: string },
  ) {
    return api.post<RoundView>(
      `/restaurant/orders/${orderId}/rounds`,
      body,
      auth(session),
    );
  },
  voidItem(session: Session, itemId: string, body: { reason: string }) {
    return api.post<void>(
      `/restaurant/order-items/${itemId}/void`,
      body,
      auth(session),
    );
  },
  close(session: Session, sessionId: string, body: { idempotencyKey?: string } = {}) {
    return api.post<{ session: TableSessionView; saleId: string }>(
      `/restaurant/table-sessions/${sessionId}/close`,
      body,
      auth(session),
    );
  },
};

// ── Kitchen ─────────────────────────────────────────────────────────────────
export const kitchen = {
  listTickets(
    session: Session,
    branchId: string,
    status?: KitchenTicketStatus | 'ALL',
  ) {
    const query = status && status !== 'ALL' ? `?status=${status}` : '';
    return api.get<KitchenTicketView[]>(
      `/restaurant/branches/${branchId}/kitchen-tickets${query}`,
      auth(session),
    );
  },
  markPrinted(
    session: Session,
    branchId: string,
    ticketId: string,
    body: { printerId: string },
  ) {
    return api.post<KitchenTicketView>(
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/mark-printed`,
      body,
      auth(session),
    );
  },
  markFailed(
    session: Session,
    branchId: string,
    ticketId: string,
    body: { printerId: string; error: string },
  ) {
    return api.post<KitchenTicketView>(
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/mark-failed`,
      body,
      auth(session),
    );
  },
  reprint(session: Session, branchId: string, ticketId: string) {
    return api.post<KitchenTicketView>(
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/reprint`,
      undefined,
      auth(session),
    );
  },
  kdsBoard(session: Session, branchId: string, status?: KitchenTicketStatus) {
    const query = status ? `?status=${status}` : '';
    return api.get<KitchenTicketView[]>(
      `/restaurant/branches/${branchId}/kds/board${query}`,
      auth(session),
    );
  },
};

export const kitchenPrinters = {
  list(session: Session, branchId: string) {
    return api.get<KitchenPrinterView[]>(
      `/restaurant/branches/${branchId}/kitchen-printers`,
      auth(session),
    );
  },
  create(
    session: Session,
    branchId: string,
    body: { code: string; name: string; kind: KitchenPrinterKind; address: string },
  ) {
    return api.post<KitchenPrinterView>(
      `/restaurant/branches/${branchId}/kitchen-printers`,
      body,
      auth(session),
    );
  },
  update(
    session: Session,
    branchId: string,
    printerId: string,
    body: Partial<{ name: string; kind: KitchenPrinterKind; address: string; isActive: boolean }>,
  ) {
    return api.patch<KitchenPrinterView>(
      `/restaurant/branches/${branchId}/kitchen-printers/${printerId}`,
      body,
      auth(session),
    );
  },
};

// ── Takeaway ────────────────────────────────────────────────────────────────
export const takeaway = {
  list(session: Session, branchId: string) {
    return api.get<TakeawayView[]>(
      `/restaurant/takeaway?branchId=${encodeURIComponent(branchId)}`,
      auth(session),
    );
  },
  create(
    session: Session,
    body: {
      branchId: string;
      customerName?: string;
      customerPhone?: string;
      pickupAt?: string;
      notes?: string;
      items: OrderItemInput[];
      idempotencyKey: string;
    },
  ) {
    return api.post<TakeawayView>(`/restaurant/takeaway`, body, auth(session));
  },
  updateStatus(session: Session, profileId: string, body: { status: TakeawayOrderStatus }) {
    return api.patch<TakeawayView>(
      `/restaurant/takeaway/${profileId}/status`,
      body,
      auth(session),
    );
  },
};

// ── Billing ────────────────────────────────────────────────────────────────
export const billing = {
  get(session: Session, saleId: string) {
    return api.get<BillView>(`/restaurant/bills/${saleId}`, auth(session));
  },
  collectPayment(
    session: Session,
    saleId: string,
    body: { amount: number; method: PaymentMethod; reference?: string },
  ) {
    return api.post<BillView>(
      `/restaurant/bills/${saleId}/payments`,
      body,
      auth(session),
    );
  },
  setSplits(
    session: Session,
    saleId: string,
    body: { splits: { label?: string; share: number }[] },
  ) {
    return api.post<BillView>(
      `/restaurant/bills/${saleId}/splits`,
      body,
      auth(session),
    );
  },
  reopen(session: Session, saleId: string, body: { reason: string }) {
    return api.post<BillView>(
      `/restaurant/bills/${saleId}/reopen`,
      body,
      auth(session),
    );
  },
};

// ── Restaurant reports ─────────────────────────────────────────────────────
function reportQuery(range?: { from?: string; to?: string; limit?: number }): string {
  if (!range) return '';
  const q = new URLSearchParams();
  if (range.from) q.set('from', range.from);
  if (range.to) q.set('to', range.to);
  if (range.limit) q.set('limit', String(range.limit));
  return q.toString() ? `?${q.toString()}` : '';
}

export const restaurantReports = {
  salesSummary(session: Session, branchId: string, range?: { from?: string; to?: string }) {
    return api.get<SalesSummaryView>(
      `/restaurant/reports/branches/${branchId}/sales-summary${reportQuery(range)}`,
      auth(session),
    );
  },
  topItems(
    session: Session,
    branchId: string,
    range?: { from?: string; to?: string; limit?: number },
  ) {
    return api.get<TopMenuItemView[]>(
      `/restaurant/reports/branches/${branchId}/top-items${reportQuery(range)}`,
      auth(session),
    );
  },
  waiterPerformance(session: Session, branchId: string, range?: { from?: string; to?: string }) {
    return api.get<WaiterPerformanceRow[]>(
      `/restaurant/reports/branches/${branchId}/waiter-performance${reportQuery(range)}`,
      auth(session),
    );
  },
  paymentBreakdown(session: Session, branchId: string, range?: { from?: string; to?: string }) {
    return api.get<PaymentBreakdownRow[]>(
      `/restaurant/reports/branches/${branchId}/payment-breakdown${reportQuery(range)}`,
      auth(session),
    );
  },
  voids(session: Session, branchId: string, range?: { from?: string; to?: string }) {
    return api.get<VoidReportRow[]>(
      `/restaurant/reports/branches/${branchId}/voids${reportQuery(range)}`,
      auth(session),
    );
  },
  channels(session: Session, branchId: string, range?: { from?: string; to?: string }) {
    return api.get<ChannelBreakdownRow[]>(
      `/restaurant/reports/branches/${branchId}/channels${reportQuery(range)}`,
      auth(session),
    );
  },
};

// ── Unified orders (Pilot Change 2 Slice D) ────────────────────────────────
export interface OrdersQuery {
  channel?: UnifiedChannel | 'ALL';
  status?: UnifiedOrderStatus | 'ALL';
  paymentStatus?: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'ALL';
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const restaurantOrders = {
  list(session: Session, branchId: string, q: OrdersQuery = {}) {
    const params = new URLSearchParams();
    if (q.channel && q.channel !== 'ALL') params.set('channel', q.channel);
    if (q.status && q.status !== 'ALL') params.set('status', q.status);
    if (q.paymentStatus && q.paymentStatus !== 'ALL') params.set('paymentStatus', q.paymentStatus);
    if (q.search) params.set('search', q.search);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    if (q.limit) params.set('limit', String(q.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return api.get<UnifiedOrderView[]>(
      `/restaurant/branches/${branchId}/orders${query}`,
      auth(session),
    );
  },
};

// ── Delivery hub ────────────────────────────────────────────────────────────
export const deliveryHub = {
  listExternalOrders(session: Session, branchId: string) {
    return api.get<ExternalOrderView[]>(
      `/delivery-hub/branches/${branchId}/external-orders`,
      auth(session),
    );
  },
  getExternalOrder(session: Session, externalOrderId: string) {
    return api.get<ExternalOrderView | null>(
      `/delivery-hub/external-orders/${externalOrderId}`,
      auth(session),
    );
  },
  acceptExternal(session: Session, externalOrderId: string) {
    return api.post<ExternalOrderView>(
      `/delivery-hub/external-orders/${externalOrderId}/accept`,
      undefined,
      auth(session),
    );
  },
};
