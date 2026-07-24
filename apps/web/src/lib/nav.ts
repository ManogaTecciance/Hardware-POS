import {
  FileText,
  LayoutDashboard,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Truck,
  Undo2,
  Users,
  Link2,
  type LucideIcon,
} from 'lucide-react';

import { Permission } from './permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** If set, the item is only shown when the user has this permission. */
  permission?: Permission;
}

export interface NavGroup {
  /** Section heading; `null` for the ungrouped lead item(s). */
  label: string | null;
  items: NavItem[];
}

/**
 * Grouped navigation. Sections give the rail rhythm and make a long list
 * scannable; the cashier simply never sees a section whose items they lack
 * permission for. Only routes that actually exist are linked.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Operations',
    items: [
      { href: '/pos', label: 'POS', icon: ShoppingCart, permission: Permission.SALE_CREATE },
      { href: '/sales', label: 'Sales', icon: ReceiptText, permission: Permission.SALE_READ },
      { href: '/quotations', label: 'Quotations', icon: FileText, permission: Permission.QUOTATION_READ },
      { href: '/returns', label: 'Returns', icon: Undo2, permission: Permission.RETURN_READ },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { href: '/products', label: 'Products', icon: Package, permission: Permission.PRODUCT_READ },
      { href: '/suppliers', label: 'Suppliers', icon: Truck, permission: Permission.SUPPLIER_READ },
      { href: '/customers', label: 'Customers', icon: Users, permission: Permission.CUSTOMER_READ },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/quickbooks', label: 'QuickBooks', icon: Link2, permission: Permission.QUICKBOOKS_READ },
      { href: '/settings', label: 'Settings', icon: Settings, permission: Permission.SETTINGS_MANAGE },
    ],
  },
];

/** Flat list (derived) — kept for any consumer that wants a single sequence. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
