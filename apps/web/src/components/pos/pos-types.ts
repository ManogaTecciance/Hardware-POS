/**
 * Shared types for the POS workspace and the dine-in order-entry screen.
 *
 * These sit outside either component tree because both consume them and a
 * cyclic import between `pos/*` and `restaurant/orders/*` would follow
 * otherwise. Keep this file **types only** — no React, no runtime code —
 * so it can be pulled by unit tests without carrying the whole component
 * graph.
 */
import type {
  MenuItemView,
  MenuView,
  ModifierGroupView,
  SectionView,
} from '@/lib/restaurant/types';

/**
 * A single line in a client-side draft — what the operator is about to
 * send to the kitchen or persist as a takeaway order.
 *
 * Snapshot fields (unitPrice, name, modifier labels) are captured at
 * add-time from the menu list, so the running subtotal displayed to the
 * operator matches the price the backend will freeze on submit. If the
 * menu is updated between add and send, the backend re-reads the *current*
 * price and freezes that — the running total is display only, never sent
 * to the server as money.
 */
export interface DraftLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: string;
  quantity: number;
  specialInstructions: string;
  modifiers: {
    optionId: string;
    optionName: string;
    groupName: string;
    priceDelta: string;
  }[];
  /**
   * Item-level discount attached at the counter. Client-side snapshot
   * only for the pilot — `RestaurantOrderItem` has no discountAmount
   * column today, so the value never leaves the browser as truth. The
   * counter workspace sums these into the Sale total displayed to the
   * cashier and reconciles against the server-calculated Sale total on
   * completion; the difference is what the operator sees as "discount".
   */
  discount?: {
    type: 'PERCENTAGE' | 'FIXED';
    value: number;
    reason?: string;
    /** Manager approval token if the discount exceeded the cashier's role limit. */
    approvalToken?: string;
    approvedByUserId?: string;
  };
}

/** Loaded menu tree for a branch — the picker's data source. */
export interface MenuData {
  menus: MenuView[];
  sectionsByMenu: Map<string, SectionView[]>;
  itemsBySection: Map<string, MenuItemView[]>;
  modifierGroupsById: Map<string, ModifierGroupView>;
}

export const EMPTY_MENU: MenuData = {
  menus: [],
  sectionsByMenu: new Map(),
  itemsBySection: new Map(),
  modifierGroupsById: new Map(),
};
