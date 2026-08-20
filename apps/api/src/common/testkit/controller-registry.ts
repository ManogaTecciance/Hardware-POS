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
import { PlatformAdminController } from '../../modules/platform-admin/platform-admin.controller';
import { ProductAttributeSchemaController } from '../../modules/products/product-attribute-schema.controller';
import { ProductComponentsController } from '../../modules/products/product-components.controller';
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
import { MenuItemImagesController } from '../../modules/menu/menu-item-images.controller';
import { MenuItemsController } from '../../modules/menu/menu-items.controller';
import { MenuSectionsController } from '../../modules/menu/menu-sections.controller';
import { MenusController } from '../../modules/menu/menus.controller';
import { ModifiersController } from '../../modules/menu/modifiers.controller';
import { DiningAreasController } from '../../modules/dining/dining-areas.controller';
import { OpenTablesController } from '../../modules/dining/open-tables.controller';
import { RestaurantTablesController } from '../../modules/dining/restaurant-tables.controller';
import { TableSessionsController } from '../../modules/table-sessions/table-sessions.controller';
import { ReservationsController } from '../../modules/reservations/reservations.controller';
import { KitchenPrintersController } from '../../modules/kitchen/kitchen-printers.controller';
import { PrintingController } from '../../modules/printing/printing.controller';
import { PrintAgentController } from '../../modules/printing/print-agent.controller';
import { KitchenTicketsController } from '../../modules/kitchen/kitchen-tickets.controller';
import { TakeawayController } from '../../modules/takeaway/takeaway.controller';
import { BillingController } from '../../modules/billing/billing.controller';
import { RestaurantReportsController } from '../../modules/restaurant-reports/restaurant-reports.controller';
import { DeliveryWebhookController } from '../../modules/delivery-hub/delivery-webhook.controller';
import { KdsController } from '../../modules/kitchen/kds.controller';
import { RestaurantOrdersController } from '../../modules/restaurant-orders/restaurant-orders.controller';
// D44 — Product variants + purchase receipts.
import { ProductImagesController } from '../../modules/products/product-images.controller';
import { ProductVariantsController } from '../../modules/products/variants/product-variants.controller';
import { InventoryReceiptsController } from '../../modules/inventory-receipts/inventory-receipts.controller';
// D45 — Restaurant Product wizard merge + Promotions.
import { ProductModifiersController } from '../../modules/products/product-modifiers.controller';
import { ProductStationsController } from '../../modules/products/product-stations.controller';
import { PromotionsController } from '../../modules/promotions/promotions.controller';
import { PosCatalogueController } from '../../modules/restaurant/pos-catalogue.controller';
import { SellableController } from '../../modules/products/sellable.controller';
import { ProductModifierGroupsController } from '../../modules/products/product-modifier-groups.controller';
import { CatalogueEntriesController } from '../../modules/catalogue/catalogue-entries.controller';
import { CollectionController } from '../../modules/catalogue/collection.controller';
import { CollectionSectionsController } from '../../modules/catalogue/collection-sections.controller';
import { CollectionsController } from '../../modules/catalogue/collections.controller';

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
  MenuItemImagesController,
  ModifiersController,
  DiningAreasController,
  RestaurantTablesController,
  // D49 — open tables.
  OpenTablesController,
  // D55 — the platform console.
  PlatformAdminController,
  TableSessionsController,
  // D47 — table reservations.
  ReservationsController,
  KitchenPrintersController,
  // D67 — the print queue's operator surface.
  PrintingController,
  PrintAgentController,
  KitchenTicketsController,
  TakeawayController,
  BillingController,
  RestaurantReportsController,
  DeliveryWebhookController,
  KdsController,
  RestaurantOrdersController,
  // D44 — Product variants + purchase receipts.
  ProductImagesController,
  ProductVariantsController,
  InventoryReceiptsController,
  // D45 — Restaurant Product wizard merge + Promotions.
  ProductModifiersController,
  ProductStationsController,
  PromotionsController,
  PosCatalogueController,
  // D62 — Phase 5 API surface.
  SellableController,
  // D64 — Phase 7 attribute schema read.
  ProductAttributeSchemaController,
  // D65 — Phase 8 recipe junction.
  ProductComponentsController,
  ProductModifierGroupsController,
  CollectionsController,
  CollectionController,
  CollectionSectionsController,
  CatalogueEntriesController,
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
  // D64 — Phase 7.
  'product-attribute-schema',
  // D65 — Phase 8.
  'product-components',
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
  'menu-item-images',
  'modifiers',
  'dining-areas',
  'restaurant-tables',
  // D49 — open tables.
  'open-tables',
  // D55 — the platform console.
  'platform-admin',
  'table-sessions',
  // D47 — table reservations.
  'reservations',
  'kitchen-printers',
  // D67.
  'printing',
  'print-agent',
  'kitchen-tickets',
  'takeaway',
  'billing',
  'restaurant-reports',
  'delivery-webhook',
  'kds',
  'restaurant-orders',
  // D44 — Product variants + purchase receipts.
  'inventory-receipts',
  'product-images',
  'product-variants',
  // D45 — Restaurant Product wizard merge + Promotions.
  'product-modifiers',
  'product-stations',
  'promotions',
  'pos-catalogue',
  // D62 — Phase 5 API surface.
  'sellable',
  'product-modifier-groups',
  'collections',
  'collection',
  'collection-sections',
  'catalogue-entries',
];
