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
}

// ── Dining ─────────────────────────────────────────────────────────────────
export interface DiningAreaView {
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  position: number;
  isActive: boolean;
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
