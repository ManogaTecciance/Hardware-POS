/**
 * Restaurant API view types, mirrored from the NestJS controllers.
 *
 * These types are the wire contract — Prisma enums duplicate here rather than
 * import from `@hardware-pos/database` because that package pulls in the
 * Prisma client, which must not reach the browser bundle. Every union is a
 * copy of what the backend service returns today; drift is caught by the
 * response-shape assertions in the component tests.
 */

export type RestaurantTableStatus =
  | 'AVAILABLE'
  | 'SEATED'
  | 'OCCUPIED'
  | 'BILLING'
  | 'CLEANING'
  | 'BLOCKED';

export type TableSessionStatus = 'OPEN' | 'BILLING' | 'CLOSED' | 'CANCELLED';

export type RestaurantOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PARTIAL'
  | 'COMPLETED'
  | 'CANCELLED';

export type OrderRoundStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_PROGRESS'
  | 'READY'
  | 'DELIVERED'
  | 'CANCELLED';

export type RestaurantOrderItemStatus =
  | 'PENDING'
  | 'SENT'
  | 'IN_PROGRESS'
  | 'READY'
  | 'DELIVERED'
  | 'VOIDED';

export type RestaurantOrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'ONLINE';

export type KitchenTicketStatus = 'QUEUED' | 'PRINTED' | 'REPRINTED' | 'FAILED';

export type KitchenPrintAttemptStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type KitchenPrinterKind =
  | 'ESC_POS_NETWORK'
  | 'ESC_POS_USB'
  | 'A4_NETWORK'
  | 'MOCK';

export type TakeawayOrderStatus =
  | 'PLACED'
  | 'IN_KITCHEN'
  | 'READY'
  | 'HANDED_OVER'
  | 'CANCELLED';

export type DeliveryPlatformKind =
  | 'MOCK'
  | 'UBER_EATS'
  | 'PICKME_FOOD'
  | 'DOORDASH'
  | 'OTHER';

export type ExternalOrderStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'IN_KITCHEN'
  | 'READY'
  | 'DELIVERED'
  | 'CANCELLED';

export type PaymentMethod =
  | 'CASH'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'QR_PAYMENT'
  | 'CHECK'
  | 'STORE_CREDIT'
  | 'OTHER';

export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';

// ── Restaurant config ──────────────────────────────────────────────────────
export interface RestaurantBranchConfigView {
  branchId: string;
  serviceChargePercent: string;
  takeawayEnabled: boolean;
  dineInEnabled: boolean;
  defaultTicketTargetMinutes: number | null;
  version: number;
  updatedAt: string;
}

// ── Kitchen stations ───────────────────────────────────────────────────────
export interface KitchenStationView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Menu ───────────────────────────────────────────────────────────────────
export interface MenuView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SectionView {
  id: string;
  menuId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
}

export type MenuItemType = 'FOOD' | 'BEVERAGE' | 'DESSERT';

/** Restaurant Menu wizard dietary chip vocabulary. Kept as a string constant
 * (not a TS enum) so tenants can extend at runtime — server stores strings. */
export const MENU_DIETARY_TAGS = ['Veg', 'Non-Veg', 'Egg', 'Spicy', 'Gluten-Free'] as const;
export type MenuDietaryTag = (typeof MENU_DIETARY_TAGS)[number];

export interface MenuItemView {
  id: string;
  sectionId: string;
  name: string;
  description: string | null;
  basePrice: string;
  productId: string | null;
  isActive: boolean;
  position: number;
  modifierGroupIds: string[];
  stationIds: string[];
  channelPrices: { channel: string; price: string }[];
  availability: { dayOfWeek: string; startTime: string; endTime: string }[];
  createdAt: string;
  updatedAt: string;
  // Presentation fields (Restaurant Menu wizard). Null on legacy rows.
  itemType: MenuItemType | null;
  prepMinutes: number | null;
  dietaryTags: string[];
  imageUrl: string | null;
}

export interface ModifierOptionView {
  id: string;
  name: string;
  priceDelta: string;
  position: number;
  isActive: boolean;
}

export interface ModifierGroupView {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  isActive: boolean;
  options: ModifierOptionView[];
  /** Wizard marker — 'SIZE' for variations, null for a plain modifier group. */
  role: string | null;
}

// ── Dining ─────────────────────────────────────────────────────────────────
export interface DiningAreaView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
  /**
   * The user who created this area. Restaurant Pilot Change 1: only that user
   * may edit or archive the row; the tables UI hides the "•••" menu on cards
   * whose creator is not the current session. Null on legacy rows the
   * additive migration could not attribute (see the migration comment).
   */
  createdByUserId: string | null;
}

export interface RestaurantTableView {
  id: string;
  areaId: string;
  branchId: string;
  code: string;
  label: string | null;
  capacity: number;
  positionX: number | null;
  positionY: number | null;
  status: RestaurantTableStatus;
  isActive: boolean;
  /** See DiningAreaView.createdByUserId — same rule, same reason. */
  createdByUserId: string | null;
}

// ── Table sessions & orders ─────────────────────────────────────────────────
export interface TableSessionView {
  id: string;
  branchId: string;
  tableId: string;
  sessionNumber: string;
  status: TableSessionStatus;
  waiterUserId: string | null;
  guestCount: number | null;
  openedAt: string;
  closedAt: string | null;
  finalSaleId: string | null;
  version: number;
}

export interface OrderView {
  id: string;
  sessionId: string;
  branchId: string;
  orderNumber: string;
  channel: RestaurantOrderChannel;
  status: RestaurantOrderStatus;
  version: number;
}

export interface RoundView {
  id: string;
  orderId: string;
  roundNumber: number;
  status: OrderRoundStatus;
  submittedAt: string | null;
  itemIds: string[];
}

/**
 * Full item as returned by `GET /table-sessions/:id/detail`. Includes the
 * snapshot fields the order-entry screen needs to render a running bill:
 * name, unit price, modifier total, quantity, item status, and the frozen
 * modifier labels.
 */
export interface SessionDetailItem {
  id: string;
  menuItemId: string;
  menuItemName: string;
  unitPrice: string;
  modifierTotal: string;
  quantity: string;
  specialInstructions: string | null;
  status: RestaurantOrderItemStatus;
  modifiers: { optionName: string; groupName: string; priceDelta: string }[];
}

export interface SessionDetail {
  session: TableSessionView;
  orders: {
    order: OrderView;
    rounds: {
      round: RoundView;
      items: SessionDetailItem[];
    }[];
  }[];
}

// ── Kitchen tickets ─────────────────────────────────────────────────────────
export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  stationId: string;
  primaryPrinterId: string | null;
  status: KitchenTicketStatus;
  items: {
    id: string;
    menuItemName: string;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
  }[];
  attempts: {
    id: string;
    printerId: string;
    status: KitchenPrintAttemptStatus;
    error: string | null;
    attemptedAt: string;
    completedAt: string | null;
  }[];
  createdAt: string;
}

export interface KitchenPrinterView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  kind: KitchenPrinterKind;
  address: string;
  isActive: boolean;
}

// ── Takeaway ────────────────────────────────────────────────────────────────
export interface TakeawayView {
  id: string;
  orderId: string;
  orderNumber: string;
  status: TakeawayOrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  pickupAt: string | null;
  handoverAt: string | null;
  notes: string | null;
  createdAt: string;
  /**
   * Populated once the underlying session has been closed on `HANDED_OVER`.
   * Null before handover. The counter POS reads this to call
   * `/bills/:saleId/payments` without a second round-trip. Pilot Change 3.
   */
  finalSaleId: string | null;
}

// ── Billing ────────────────────────────────────────────────────────────────
export interface BillView {
  saleId: string;
  saleNumber: string;
  subtotal: string;
  serviceChargeAmount: string;
  packagingCharge: string;
  total: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: PaymentStatus;
  splits: {
    id: string;
    label: string | null;
    share: string;
    paidAmount: string;
  }[];
  payments: {
    id: string;
    amount: string;
    method: PaymentMethod;
    reference: string | null;
  }[];
}

// ── Orders (unified read-model, Pilot Change 2 Slice D) ────────────────────
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

export interface UnifiedOrderView {
  id: string;
  channel: UnifiedChannel;
  source: UnifiedSource;
  orderNumber: string;
  unifiedStatus: UnifiedOrderStatus;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | null;
  customerName: string | null;
  customerPhone: string | null;
  contextLabel: string | null;
  pickupAt: string | null;
  createdAt: string;
  total: string | null;
  itemCount: number;
  itemPreview: { name: string; qty: number }[];
}

// ── Reports ─────────────────────────────────────────────────────────────────
export interface SalesSummaryView {
  branchId: string;
  from: string;
  to: string;
  sessionsClosed: number;
  ordersServed: number;
  itemsSold: string;
  netRevenue: string;
  serviceChargeCollected: string;
  paymentsCollected: string;
  bySaleStatus: Record<string, number>;
}

export interface TopMenuItemView {
  menuItemId: string;
  menuItemName: string;
  quantitySold: string;
  revenue: string;
}

export interface WaiterPerformanceRow {
  userId: string;
  sessionsHandled: number;
  roundsSubmitted: number;
  totalRevenue: string;
}

export interface PaymentBreakdownRow {
  method: string;
  count: number;
  amount: string;
}

export interface VoidReportRow {
  itemId: string;
  menuItemName: string;
  quantity: string;
  reason: string;
  voidedAt: string;
  voidedByUserId: string | null;
}

export interface ChannelBreakdownRow {
  channel: RestaurantOrderChannel;
  orders: number;
}

// ── Delivery hub ────────────────────────────────────────────────────────────
export interface ExternalOrderView {
  id: string;
  externalOrderRef: string;
  platformKind: DeliveryPlatformKind;
  status: ExternalOrderStatus;
  externalTotal: string | null;
  restaurantOrderId: string | null;
  receivedAt: string;
}

// ── Order-item input (used by round submit + takeaway create) ───────────────
export interface OrderItemInput {
  menuItemId: string;
  quantity: number;
  specialInstructions?: string;
  modifiers?: { modifierOptionId: string }[];
}
