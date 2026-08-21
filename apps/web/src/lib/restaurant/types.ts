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
  | 'BLOCKED'
  // D49: physically absorbed into an open table; refuses its own sessions.
  | 'RESERVED';

/** D49. PHYSICAL is the floor plan; OPEN is an ad-hoc joined arrangement. */
export type RestaurantTableKind = 'PHYSICAL' | 'OPEN';

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

// D68 — PRINTED/REPRINTED/FAILED are retired: no code path produces them,
// but pre-D68 rows still carry them and the board must render those.
export type KitchenTicketStatus =
  | 'QUEUED'
  | 'PRINTED'
  | 'REPRINTED'
  | 'FAILED'
  | 'COMPLETED';

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
  /** D84 — which channels levy it. DINE_IN by default. */
  serviceChargeChannels: string[];
  /** D84 — whether the charge sits inside the taxable base. */
  serviceChargeTaxable: boolean;
  /** D84 — flat per-order packaging charge for takeaway/online. */
  packagingChargeAmount: string;
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

/**
 * D46 — a POS Catalogue variant, projected onto the MenuItemView shape so
 * the runtime picker + Customise dialog can consume both source paths
 * through one type. `unitPrice` is the ABSOLUTE variant price (not a
 * delta on top of `basePrice`); the Customise dialog must not stack the
 * two — see the D46 anti-pattern guard in `customise-dialog.render.test.tsx`.
 */
export interface MenuItemVariantView {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  isDefault: boolean;
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
  // Presentation fields (Restaurant Menu wizard). Null on legacy rows.
  itemType: MenuItemType | null;
  prepMinutes: number | null;
  dietaryTags: string[];
  imageUrl: string | null;
  /**
   * D46 — discriminator for the source authority of this view row.
   *   `'PRODUCT'`   — shaped by the POS Catalogue adapter from a Product
   *                   (D45); `id` is the Product id and `variants` may
   *                   carry active ProductVariants.
   *   `'MENU_ITEM'` — legacy admin-menu row; `id` is the MenuItem id.
   * Omitted defaults to `'MENU_ITEM'` so consumers that do not care about
   * the distinction (existing selectors, wizard, etc.) keep working
   * unchanged. `productId` above is a linked-Product FK on the legacy path
   * and cannot be used as a source discriminator — a MenuItem can also
   * link to a Product for inventory purposes.
   */
  catalogueSource?: 'PRODUCT' | 'MENU_ITEM';
  /**
   * D46 — active variants when the row was shaped from a Product with
   * variations. Undefined or empty on legacy MenuItems and on Products
   * without variations. The runtime Customise dialog renders these as
   * single-select radios above the modifier groups when non-empty.
   */
  variants?: MenuItemVariantView[];
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

// D47 — table reservations. Timeslots are half-open [startAt, endAt);
// instants travel as ISO strings. Contact fields are booking-time snapshots,
// so a reservation renders even when its Customer row is gone.
export type ReservationStatus = 'BOOKED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface ReservationView {
  id: string;
  branchId: string;
  tableId: string;
  reservationNumber: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  startAt: string;
  endAt: string;
  status: ReservationStatus;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface RestaurantTableView {
  id: string;
  /** Null only for kind=OPEN — ad-hoc tables belong to no floor area (D49). */
  areaId: string | null;
  branchId: string;
  kind: RestaurantTableKind;
  code: string;
  label: string | null;
  /** Null only for kind=OPEN with no recorded seats (D49). */
  capacity: number | null;
  positionX: number | null;
  positionY: number | null;
  status: RestaurantTableStatus;
  isActive: boolean;
  /** See DiningAreaView.createdByUserId — same rule, same reason. */
  createdByUserId: string | null;
}

/**
 * D50 — what a close/dissolve did to an arrangement's physical tables.
 * `stillReserved` is what the billing reminder asks the operator to check.
 */
export interface OpenTableReleaseSummary {
  released: Array<{ id: string; code: string; label: string | null }>;
  stillReserved: Array<{
    id: string;
    code: string;
    label: string | null;
    heldBy: Array<{ id: string; code: string; label: string | null }>;
  }>;
}

/** D49 — an open table plus the physical tables it absorbed. */
export interface OpenTableView extends RestaurantTableView {
  members: Array<{
    id: string;
    code: string;
    label: string | null;
    areaId: string | null;
    status: RestaurantTableStatus;
  }>;
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
  /** D71 — "Medium" vs "Large" is what a guest is being charged for. */
  variantName: string | null;
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

/** D71 — the running bill for a session that has not closed yet. */
export interface SessionBillPreview {
  sessionId: string;
  items: {
    orderItemId: string;
    name: string;
    variantName: string | null;
    unitPrice: string;
    quantity: string;
    lineTotal: string;
    roundNumber: number | null;
    /** D72 — "no onions". Shown at the table and printed on the bill. */
    specialInstructions: string | null;
  }[];
  subtotal: string;
  serviceChargeAmount: string;
  packagingCharge: string;
  taxAmount: string;
  total: string;
}

/** D83 — every item on the order behind a ticket, for the kitchen's Details view. */
export interface KitchenOrderView {
  ticketId: string;
  ticketNumber: string;
  orderNumber: string | null;
  placeLabel: string | null;
  waiterName: string | null;
  placedAt: string;
  items: {
    id: string;
    name: string;
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
    roundNumber: number | null;
    stationName: string | null;
  }[];
}

// ── Kitchen tickets ─────────────────────────────────────────────────────────
export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  stationId: string;
  stationName: string;
  status: KitchenTicketStatus;
  /** D68 — where the food is going. The board is the only delivery. */
  orderNumber: string | null;
  placeLabel: string | null;
  roundNumber: number | null;
  waiterName: string | null;
  items: {
    id: string;
    menuItemName: string;
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
  }[];
  completedAt: string | null;
  completedByName: string | null;
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
/** D51 — one orderable line on the bill, and how much of it is spoken for. */
export interface BillLineItem {
  orderItemId: string;
  name: string;
  variantName: string | null;
  /** Unit price including snapshotted modifier deltas. */
  unitPrice: string;
  quantity: string;
  lineTotal: string;
  assignedQuantity: string;
  /** D72 — "no onions". Printed under the line it belongs to. */
  specialInstructions: string | null;
}

export interface BillView {
  saleId: string;
  saleNumber: string;
  subtotal: string;
  /** D72 — discount taken off the bill; printed whenever it is non-zero. */
  totalDiscount: string;
  serviceChargeAmount: string;
  packagingCharge: string;
  /** D72 — the branch's tax. */
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: PaymentStatus;
  /** D72 — receipt header. */
  servedByName: string | null;
  placeLabel: string | null;
  closedAt: string;
  /** D51 — the lines behind the totals. */
  items: BillLineItem[];
  splits: {
    id: string;
    label: string | null;
    share: string;
    paidAmount: string;
    /** D51 — lines this split covers; empty for an amount-only split. */
    items: { orderItemId: string; name: string; quantity: string; lineTotal: string }[];
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
  /** D83 — the settled Sale, for viewing and reprinting the bill in place. */
  saleId: string | null;
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
/** Modifier option reference on a submitted round item. */
export interface OrderItemModifierInput {
  modifierOptionId: string;
}

/**
 * D46 — the round-submission wire shape is now a discriminated union so
 * PRODUCT-sourced items (POS Catalogue) can be sent alongside the legacy
 * MENU_ITEM path without either branch permitting the other's fields.
 *
 * Historical clients that omit `sourceKind` are still accepted by the
 * backend (DTO defaults to `MENU_ITEM`) so the `'MENU_ITEM'` branch
 * treats the discriminator as optional to keep every existing call site
 * — takeaway.create in this workspace, order-entry.tsx in dine-in —
 * compiling verbatim without a discriminator field.
 */
export type OrderItemInput =
  | {
      sourceKind?: 'MENU_ITEM';
      menuItemId: string;
      quantity: number;
      specialInstructions?: string;
      modifiers?: OrderItemModifierInput[];
    }
  | {
      sourceKind: 'PRODUCT';
      productId: string;
      productVariantId?: string;
      quantity: number;
      specialInstructions?: string;
      modifiers?: OrderItemModifierInput[];
    };
