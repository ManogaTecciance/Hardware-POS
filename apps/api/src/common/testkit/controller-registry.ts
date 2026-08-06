/**
 * Every controller the API registers, in one list.
 *
 * **Test-only.** Nothing in the running application imports this.
 *
 * This is the hand-maintained half of the route-module matrix, and therefore the
 * one place the matrix could go quietly incomplete: a new controller that is never
 * added here would simply not be classified, and every "each route is classified"
 * assertion would still pass.
 *
 * `route-module-matrix.spec.ts` closes that by walking `src/` for
 * `*.controller.ts` files and comparing the file names against the classes below.
 * Adding a controller without listing it here fails that comparison by name.
 */

import { HealthController } from '../../health/health.controller';
import { AuditLogController } from '../../modules/audit-log/audit-log.controller';
import { RolesController } from '../../modules/roles/roles.controller';
import { UserRolesController } from '../../modules/roles/user-roles.controller';
import { AuthController } from '../../modules/auth/auth.controller';
import { BranchesController } from '../../modules/branches/branches.controller';
import { CategoriesController } from '../../modules/categories/categories.controller';
import { ProductCategoriesController } from '../../modules/categories/product-categories.controller';
import { ProductSubcategoriesController } from '../../modules/categories/product-subcategories.controller';
import { CustomersController } from '../../modules/customers/customers.controller';
import { DashboardController } from '../../modules/dashboard/dashboard.controller';
import { DiscountsController } from '../../modules/discounts/discounts.controller';
import { DocumentsController } from '../../modules/documents/documents.controller';
import { PaymentsController } from '../../modules/payments/payments.controller';
import { PlatformController } from '../../modules/platform/platform.controller';
import { ProductsController } from '../../modules/products/products.controller';
import { QuickBooksController } from '../../modules/quickbooks/quickbooks.controller';
import { PublicQuotationsController } from '../../modules/quotations/public-quotations.controller';
import { QuotationsController } from '../../modules/quotations/quotations.controller';
import { PrintJobsController } from '../../modules/receipts/print-jobs.controller';
import { ReceiptsController } from '../../modules/receipts/receipts.controller';
import { ReturnsSalesController } from '../../modules/returns/returns-sales.controller';
import { ReturnsController } from '../../modules/returns/returns.controller';
import { SalesController } from '../../modules/sales/sales.controller';
import { SettingsController } from '../../modules/settings/settings.controller';
import { SuppliersController } from '../../modules/suppliers/suppliers.controller';
import { SyncController } from '../../modules/sync/sync.controller';
import { UserBranchAccessController } from '../../modules/users/user-branch-access.controller';
import { UsersController } from '../../modules/users/users.controller';
import { KitchenStationsController } from '../../modules/restaurant/kitchen-stations.controller';
import { RestaurantConfigController } from '../../modules/restaurant/restaurant-config.controller';
import { MenuItemsController } from '../../modules/menu/menu-items.controller';
import { MenuSectionsController } from '../../modules/menu/menu-sections.controller';
import { MenusController } from '../../modules/menu/menus.controller';
import { ModifiersController } from '../../modules/menu/modifiers.controller';
import { DiningAreasController } from '../../modules/dining/dining-areas.controller';
import { RestaurantTablesController } from '../../modules/dining/restaurant-tables.controller';
import { TableSessionsController } from '../../modules/table-sessions/table-sessions.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_CONTROLLERS: (new (...args: any[]) => object)[] = [
  AuditLogController,
  AuthController,
  BranchesController,
  CategoriesController,
  CustomersController,
  DashboardController,
  DiscountsController,
  DocumentsController,
  HealthController,
  PaymentsController,
  PlatformController,
  PrintJobsController,
  ProductCategoriesController,
  ProductSubcategoriesController,
  ProductsController,
  PublicQuotationsController,
  QuickBooksController,
  QuotationsController,
  ReceiptsController,
  RolesController,
  UserRolesController,
  ReturnsController,
  ReturnsSalesController,
  SalesController,
  SettingsController,
  SuppliersController,
  SyncController,
  UserBranchAccessController,
  UsersController,
  RestaurantConfigController,
  KitchenStationsController,
  MenusController,
  MenuSectionsController,
  MenuItemsController,
  ModifiersController,
  DiningAreasController,
  RestaurantTablesController,
  TableSessionsController,
];

/**
 * The controller **file** base names this registry covers.
 *
 * Declared explicitly rather than derived from the class names: `QuickBooksController`
 * lives in `quickbooks.controller.ts`, so any camel-case→kebab transform gets it
 * wrong (`quick-books`), and a test built on a wrong transform fails for a reason
 * that has nothing to do with coverage. This list is compared against the files on
 * disk, so a new controller must be added here as well as to `ALL_CONTROLLERS`.
 */
export const REGISTERED_CONTROLLER_FILES: readonly string[] = [
  'audit-log',
  'roles',
  'user-roles',
  'auth',
  'branches',
  'categories',
  'customers',
  'dashboard',
  'discounts',
  'documents',
  'health',
  'payments',
  'platform',
  'print-jobs',
  'product-categories',
  'product-subcategories',
  'products',
  'public-quotations',
  'quickbooks',
  'quotations',
  'receipts',
  'returns',
  'returns-sales',
  'sales',
  'settings',
  'suppliers',
  'sync',
  'user-branch-access',
  'users',
  'kitchen-stations',
  'restaurant-config',
  'menus',
  'menu-sections',
  'menu-items',
  'modifiers',
  'dining-areas',
  'restaurant-tables',
  'table-sessions',
];
