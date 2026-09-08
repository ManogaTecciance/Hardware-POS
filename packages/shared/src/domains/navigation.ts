/**
 * Navigation as data (convergence plan §4.4, D56).
 *
 * The nav lists moved here from `apps/web/src/lib/nav.ts` so a domain
 * descriptor can own its navigation. A descriptor in a shared package cannot
 * import a React component, so icons are referenced BY NAME; the web binds
 * names to `lucide-react` components in exactly one map (`nav-icons.ts`), and
 * the `NavIconName` union being derived from that map's keys is what makes a
 * typo'd icon a compile error rather than a blank slot.
 *
 * `resolveNavigation` on the web keeps its three filters (business type →
 * module → permission) and its behavioural tests unchanged — only the SOURCE
 * of the base list moved.
 */
import { Permission } from '../types/authorization.js';
import type { ModuleKey } from '../types/platform.js';

/**
 * Icon vocabulary. Every name here must resolve in the web's `NAV_ICONS`
 * map — `nav-icon-totality` asserts the two sets are identical, both ways.
 */
export const NAV_ICON_NAMES = [
  'BarChart3',
  'CalendarDays',
  'ChefHat',
  'FileText',
  'LayoutDashboard',
  'Link2',
  'ListChecks',
  'Package',
  'ReceiptText',
  'Settings',
  'ShoppingCart',
  'Truck',
  'Undo2',
  'UtensilsCrossed',
  'Users',
] as const;
export type NavIconName = (typeof NAV_ICON_NAMES)[number];

export interface NavItemSpec {
  readonly href: string;
  readonly label: string;
  readonly icon: NavIconName;
  /**
   * Shown only when the user holds this permission.
   *
   * D93 — an ARRAY means any-of: holding one of them is enough. A destination
   * that more than one job can reach lists every capability that reaches it,
   * rather than borrowing an unrelated permission as a proxy for "works here".
   * `/pos` in a food-service workspace is the case that forced this: the
   * waiter arrives there to send a round to the kitchen and the till arrives
   * to ring up a takeaway, and gating on one of those hid the screen from the
   * other.
   *
   * Widening this field rather than adding a sibling `anyPermission` is
   * deliberate. `bindGroups` in the web app copies spec fields by an explicit
   * whitelist, so a NEW field that someone forgets to copy produces an item
   * with no gate at all — fail-open. Widening the existing one makes every
   * consumer a compile error instead.
   */
  readonly permission?: Permission | readonly Permission[];
  /**
   * Shown only when the tenant has this module enabled.
   *
   * Omitted for shared-core destinations that every business profile needs
   * (dashboard, products, settings). Those are still permission-gated.
   */
  readonly module?: ModuleKey;
  /**
   * The route exists but the feature behind it is not built yet.
   * Rendered with a visible "Soon" marker rather than hidden, so an
   * incomplete workspace never looks complete.
   */
  readonly upcoming?: boolean;
}

export interface NavGroupSpec {
  /** Section heading; `null` for the ungrouped lead item(s). */
  readonly label: string | null;
  readonly items: readonly NavItemSpec[];
}

/**
 * Navigation for the hardware/retail workspace.
 *
 * **This is the pre-Slice-8 list, unchanged**, with `module` keys added. A
 * legacy tenant has every one of those modules enabled by default, so the
 * rendered result is identical to what shipped before — asserted by
 * `nav.test.ts`.
 */
export const RETAIL_NAVIGATION: readonly NavGroupSpec[] = [
  {
    label: null,
    items: [{ href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' }],
  },
  {
    label: 'Operations',
    items: [
      {
        href: '/pos',
        label: 'POS',
        icon: 'ShoppingCart',
        permission: Permission.SALE_CREATE,
        module: 'RETAIL_POS',
      },
      // No module key: completed-sale history is shared core, classified by the
      // product owner after Slice 8. Every business profile needs to look up
      // what it has already sold, and the API gates the sales controller on no
      // module either. `RETAIL_POS` governs *taking* a sale, which is a retail
      // workflow.
      { href: '/sales', label: 'Sales', icon: 'ReceiptText', permission: Permission.SALE_READ },
      {
        href: '/quotations',
        label: 'Quotations',
        icon: 'FileText',
        permission: Permission.QUOTATION_READ,
        module: 'QUOTATIONS',
      },
      {
        href: '/returns',
        label: 'Returns',
        icon: 'Undo2',
        permission: Permission.RETURN_READ,
        module: 'RETURNS',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      // No module key: the product catalogue is shared core. `INVENTORY` means
      // stock tracking, which is governed by InventoryMode (D28/D31/D35) —
      // gating the catalogue on it would hide products from a tenant that owns
      // them.
      { href: '/products', label: 'Products', icon: 'Package', permission: Permission.PRODUCT_READ },
      {
        href: '/suppliers',
        label: 'Suppliers',
        icon: 'Truck',
        permission: Permission.SUPPLIER_READ,
        module: 'SUPPLIERS',
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: 'Users',
        permission: Permission.CUSTOMER_READ,
        module: 'CUSTOMERS',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        href: '/quickbooks',
        label: 'QuickBooks',
        icon: 'Link2',
        permission: Permission.QUICKBOOKS_READ,
        module: 'QUICKBOOKS',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: 'Settings',
        permission: Permission.SETTINGS_MANAGE,
        module: 'SETTINGS',
      },
    ],
  },
];

/**
 * Navigation for a food-service workspace.
 *
 * Deliberately absent: POS-retail concerns — Quotations, Returns, Suppliers
 * and QuickBooks (decision D2). A food-service profile does not enable their
 * modules, so even without this list they would be filtered out. Both
 * mechanisms agree, and `nav.test.ts` asserts it from both directions.
 */
export const FOOD_SERVICE_NAVIGATION: readonly NavGroupSpec[] = [
  {
    label: null,
    items: [{ href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' }],
  },
  {
    label: 'Service',
    items: [
      {
        // Pilot Change 2 Slice B — unified POS workspace with mode selector
        // (Dine In / Takeaway / 3rd Party). Takeaway lives as `POS → Takeaway`
        // per PO decision 3.
        href: '/pos',
        label: 'POS',
        icon: 'ShoppingCart',
        /*
         * D93 — the capabilities this screen actually offers, which is what
         * decides whether there is anything behind the door:
         *   ORDER_SEND_TO_KITCHEN → Dine In
         *   TAKEAWAY_CREATE       → Takeaway, and Delivery with PAYMENT_COLLECT
         * exactly the set `pos-counter-workspace.tsx` turns into the mode
         * chooser. SALE_CREATE stays in the list so nobody who reaches POS
         * today loses it, but it is no longer what the entry hangs on: it is a
         * RETAIL permission that the restaurant till deliberately does not
         * hold (D87), so gating on it hid the POS from the one role whose job
         * is ringing up takeaway and delivery orders.
         */
        permission: [
          Permission.SALE_CREATE,
          Permission.ORDER_SEND_TO_KITCHEN,
          Permission.TAKEAWAY_CREATE,
        ],
        module: 'TABLE_MANAGEMENT',
      },
      {
        // Pilot Change 2 Slice D — unified Orders queue across every channel.
        href: '/orders',
        label: 'Orders',
        icon: 'ListChecks',
        permission: Permission.TABLE_VIEW,
        module: 'TABLE_MANAGEMENT',
      },
      {
        href: '/kitchen',
        label: 'Kitchen',
        icon: 'ChefHat',
        permission: Permission.KOT_VIEW,
        module: 'KITCHEN',
      },
      {
        href: '/tables',
        label: 'Tables',
        icon: 'UtensilsCrossed',
        permission: Permission.SALE_CREATE,
        module: 'TABLE_MANAGEMENT',
      },
      {
        // D47 — the reservation book: day grid of tables × timeslots.
        href: '/calendar',
        label: 'Calendar',
        icon: 'CalendarDays',
        permission: Permission.RESERVATION_VIEW,
        module: 'RESERVATIONS',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      // D45: `/menu` is intentionally absent. The Product Wizard (Restaurant)
      // is the single authoring surface for sellable items; the legacy
      // MenuBrowser stays reachable only via a typed URL. Do not re-add a
      // `/menu` entry without a decision record.
      //
      // Food-service tenants label the shared product catalogue "Inventory"
      // so it reads clearly as the authoring surface for every sellable item.
      {
        href: '/products',
        label: 'Inventory',
        icon: 'Package',
        permission: Permission.PRODUCT_READ,
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: 'Users',
        permission: Permission.CUSTOMER_READ,
        module: 'CUSTOMERS',
      },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/sales', label: 'Sales', icon: 'ReceiptText', permission: Permission.SALE_READ },
      {
        href: '/reports',
        label: 'Reports',
        icon: 'BarChart3',
        permission: Permission.REPORT_READ,
        module: 'REPORTING',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: 'Settings',
        permission: Permission.SETTINGS_MANAGE,
        module: 'SETTINGS',
      },
    ],
  },
];
