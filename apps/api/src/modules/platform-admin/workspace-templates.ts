import { BusinessType } from '@hardware-pos/database';

/**
 * D55 — the workspace templates a platform admin can choose from.
 *
 * A template is a named `BusinessType`, not a new entity: that enum already
 * drives the navigation map, the default module set, the business-profile
 * preset and the role templates. Adding a fourth template is therefore a
 * `BusinessType` value plus its entries in those maps — the compiler demands
 * every one of them, because each map is a total `Record<BusinessType, …>`.
 *
 * HOTEL currently mirrors RESTAURANT in every map. It is a distinct value so
 * hotel workspaces are distinguishable in data from the day they are created;
 * when hotels need their own navigation that is a map change, not a migration
 * across live tenants.
 */
export interface WorkspaceTemplate {
  key: string;
  name: string;
  description: string;
  businessType: BusinessType;
}

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = [
  {
    key: 'HARDWARE',
    name: 'Hardware / Retail',
    description:
      'Counter sales, stock control, quotations, returns and supplier management. QuickBooks-backed inventory and accounting.',
    businessType: BusinessType.HARDWARE,
  },
  {
    key: 'RESTAURANT',
    name: 'Restaurant',
    description:
      'Dining areas and tables, table sessions, kitchen tickets, takeaway and per-table billing. Local inventory, no accounting provider.',
    businessType: BusinessType.RESTAURANT,
  },
  {
    key: 'HOTEL',
    name: 'Hotel',
    description:
      'Mirrors the restaurant workspace today — food and beverage service for a hotel. Its own workspace type so it can diverge later without moving live tenants.',
    businessType: BusinessType.HOTEL,
  },
];

export function templateByKey(key: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((t) => t.key === key);
}
