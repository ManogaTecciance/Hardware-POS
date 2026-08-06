# Route → module matrix

Generated and enforced by
`apps/api/src/common/guards/route-module-matrix.spec.ts`, which reads Nest's own
route metadata off the real controller classes. **Do not edit the totals by hand** —
that spec fails when this document and the code disagree.

- Total routes: 177
- Module-guarded routes: 132
- Ungated routes: 45

## How to read the Guard column

| Value | Meaning |
|---|---|
| `ENFORCED` | `@RequireModule` is applied today; `ModuleAccessGuard` denies the route when the tenant has the module switched off. |
| `shared-core` | Authentication, tenant isolation and permissions only. These routes must work for **every** business profile, so gating them would be wrong rather than merely unfinished. |
| `public-no-tenant` | `@Public()` route. `ModuleAccessGuard` denies any route requiring a module without an authenticated tenant (the `x-tenant-id` header is client-supplied and untrusted), so these **cannot** carry a module guard. Each enforces its own token instead. |

## Guard rollout in Slice 7.6

Applied at **controller level** where the whole controller belongs to one module:
`CustomersController` (CUSTOMERS), `ReturnsController` and `ReturnsSalesController`
(RETURNS), `SuppliersController` (SUPPLIERS), `SyncController` (QUICKBOOKS),
`DashboardController` (REPORTING), `UsersController` (USERS), `BranchesController`
(BRANCHES), `SettingsController` (SETTINGS). `QuotationsController` (QUOTATIONS)
was already gated in Slice 4.

Applied at **route level** where a controller is mixed:

- `QuickBooksController` — every route except the `@Public()` OAuth `callback`.
- `POST /products/:id/sync-to-quickbooks`, `POST /products/sync/mock`,
  `POST /customers/:id/sync-to-quickbooks` — QuickBooks operations living on
  otherwise provider-neutral controllers.

**Tile Shop is unaffected.** Every module gated above is in the legacy default set
(`LEGACY_TENANT_DEFAULTS`), so a tenant with no profile row resolves to having all
of them enabled and every route behaves exactly as before. This is asserted by
`platform-legacy-compatibility.spec.ts` and by the full Playwright suite.

## Guard rollout completed in Phase 1.5.9

**`RETAIL_POS` on the sale *write* path, payments, receipts, print jobs and
discounts** now carries `@RequireModule` — see the individual entries below.
Taking a sale, collecting payment and printing a receipt are retail workflows;
a Restaurant tenant reaches these routes only through the retail POS module.
When Restaurant Phase 2 lands the operational-order routes, they are a
separate model on separate routes and do not change this classification.

**Sale *reads* remain `SHARED_CORE`.** `GET /sales`, `GET /sales/:id` and
`GET /sales/report` every business profile needs to look up what it has already
sold. Access continues to depend on authentication, tenant isolation, branch
isolation where applicable, and the existing `sale:read` permission — removing
a module requirement is not removing protection. Asserted in
`route-module-matrix.spec.ts`.

**`INVENTORY` on `/products` and the category controllers.** Products are the
*catalogue*, which every business profile needs; `INVENTORY` means *stock
tracking*, which is already governed by `InventoryMode` and the catalogue provider
(decisions D28, D31). Gating catalogue CRUD on `INVENTORY` would stop a Restaurant
tenant managing its own products, contradicting the Phase 1 acceptance criteria.
Classified `SHARED_CORE` deliberately, not by omission.

**`DocumentsController` per-route gating.** Sale bills → `RETAIL_POS`, return
notes → `RETURNS`, settings previews → `SETTINGS`. Applied at the handler,
not the class, because the four routes serve three different modules.

## Every future Restaurant controller

Must carry `@RequireModule` and therefore fail closed. `route-module-matrix.spec.ts`
fails on any route it has not been told about, so a new Restaurant controller cannot
reach production unclassified.

## The matrix


### AuditLogController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/audit-logs` | SHARED_CORE | shared-core | — |

### AuthController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/auth/accessible-branches` | SHARED_CORE | shared-core | — |
| POST | `/auth/active-branch` | SHARED_CORE | shared-core | — |
| POST | `/auth/login` | SHARED_CORE | shared-core | _public_ |
| POST | `/auth/logout` | SHARED_CORE | shared-core | _public_ |
| GET | `/auth/me` | SHARED_CORE | shared-core | — |
| POST | `/auth/pin-login` | SHARED_CORE | shared-core | _public_ |
| POST | `/auth/refresh` | SHARED_CORE | shared-core | _public_ |

### BranchesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/branches` | BRANCHES | ENFORCED | — |

### CategoriesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/categories` | SHARED_CORE | shared-core | product:read |

### CustomersController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/customers` | CUSTOMERS | ENFORCED | customer:read |
| POST | `/customers` | CUSTOMERS | ENFORCED | customer:manage |
| GET | `/customers/:id` | CUSTOMERS | ENFORCED | customer:read |
| PATCH | `/customers/:id` | CUSTOMERS | ENFORCED | customer:manage |
| POST | `/customers/:id/sync-to-quickbooks` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| POST | `/customers/import/commit` | CUSTOMERS | ENFORCED | customer:manage |
| POST | `/customers/import/preview` | CUSTOMERS | ENFORCED | customer:manage |
| GET | `/customers/import/template` | CUSTOMERS | ENFORCED | customer:manage |

### DashboardController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/dashboard/payment-methods` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/sales-series` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/shift-summary` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/stats` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/summary` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/top-categories` | REPORTING | ENFORCED | sale:read |
| GET | `/dashboard/top-products` | REPORTING | ENFORCED | sale:read |

### DiscountsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| POST | `/discounts/approve` | RETAIL_POS | ENFORCED | sale:create |

### DocumentsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| POST | `/documents/preview/:type` | SETTINGS | ENFORCED | settings:manage |
| GET | `/documents/returns/:returnId` | RETURNS | ENFORCED | return:read |
| GET | `/documents/sales/:saleId` | RETAIL_POS | ENFORCED | sale:read |
| GET | `/documents/sample-pdf/:type` | SETTINGS | ENFORCED | settings:manage |

### HealthController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/health` | SHARED_CORE | shared-core | _public_ |

### PaymentsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/payments` | RETAIL_POS | ENFORCED | — |
| POST | `/payments` | RETAIL_POS | ENFORCED | payment:create |
| GET | `/payments/:id` | RETAIL_POS | ENFORCED | — |

### PlatformController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/platform/modules` | SHARED_CORE | shared-core | platform:profile:read |
| GET | `/platform/profile` | SHARED_CORE | shared-core | platform:profile:read |
| PATCH | `/platform/profile` | SHARED_CORE | shared-core | platform:profile:manage |

### PrintJobsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/print-jobs` | RETAIL_POS | ENFORCED | sale:read |
| POST | `/print-jobs/:id/mark-printed` | RETAIL_POS | ENFORCED | sale:create |

### ProductCategoriesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/product-categories` | SHARED_CORE | shared-core | product:read |
| POST | `/product-categories` | SHARED_CORE | shared-core | category:manage |
| GET | `/product-categories/:id` | SHARED_CORE | shared-core | product:read |
| PATCH | `/product-categories/:id` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-categories/:id/deactivate` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-categories/:id/reactivate` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-categories/reorder` | SHARED_CORE | shared-core | category:manage |

### ProductSubcategoriesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/product-subcategories` | SHARED_CORE | shared-core | product:read |
| POST | `/product-subcategories` | SHARED_CORE | shared-core | category:manage |
| GET | `/product-subcategories/:id` | SHARED_CORE | shared-core | product:read |
| PATCH | `/product-subcategories/:id` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-subcategories/:id/deactivate` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-subcategories/:id/move` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-subcategories/:id/reactivate` | SHARED_CORE | shared-core | category:manage |
| POST | `/product-subcategories/reorder` | SHARED_CORE | shared-core | category:manage |

### ProductsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/products` | SHARED_CORE | shared-core | product:read |
| POST | `/products` | SHARED_CORE | shared-core | product:manage |
| DELETE | `/products/:id` | SHARED_CORE | shared-core | product:manage |
| GET | `/products/:id` | SHARED_CORE | shared-core | product:read |
| PATCH | `/products/:id` | SHARED_CORE | shared-core | product:manage |
| DELETE | `/products/:id/image` | SHARED_CORE | shared-core | product:manage |
| POST | `/products/:id/image` | SHARED_CORE | shared-core | product:manage |
| POST | `/products/:id/sync-to-quickbooks` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| POST | `/products/import/commit` | SHARED_CORE | shared-core | product:manage |
| POST | `/products/import/preview` | SHARED_CORE | shared-core | product:manage |
| GET | `/products/import/template` | SHARED_CORE | shared-core | product:manage |
| GET | `/products/report` | SHARED_CORE | shared-core | product:read |
| GET | `/products/search` | SHARED_CORE | shared-core | product:read |
| POST | `/products/sync/mock` | QUICKBOOKS | ENFORCED | quickbooks:manage |

### PublicQuotationsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/public/quotations/:token` | QUOTATIONS | public-no-tenant | _public_ |

### QuickBooksController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/quickbooks/callback` | QUICKBOOKS | public-no-tenant | _public_ |
| GET | `/quickbooks/connect` | QUICKBOOKS | ENFORCED | — |
| POST | `/quickbooks/disconnect` | QUICKBOOKS | ENFORCED | — |
| GET | `/quickbooks/party-sync-status` | QUICKBOOKS | ENFORCED | quickbooks:read |
| POST | `/quickbooks/retry/:syncLogId` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| GET | `/quickbooks/status` | QUICKBOOKS | ENFORCED | quickbooks:read |
| POST | `/quickbooks/sync` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| POST | `/quickbooks/sync-products` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| POST | `/quickbooks/sync-sale/:saleId` | QUICKBOOKS | ENFORCED | quickbooks:manage |
| GET | `/quickbooks/vendors` | QUICKBOOKS | ENFORCED | supplier:qb:map |

### QuotationsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/quotations` | QUOTATIONS | ENFORCED | quotation:read |
| POST | `/quotations` | QUOTATIONS | ENFORCED | quotation:create |
| GET | `/quotations/:id` | QUOTATIONS | ENFORCED | quotation:read |
| PATCH | `/quotations/:id` | QUOTATIONS | ENFORCED | quotation:create |
| POST | `/quotations/:id/cancel` | QUOTATIONS | ENFORCED | quotation:cancel |
| POST | `/quotations/:id/convert-to-sale` | QUOTATIONS | ENFORCED | quotation:convert |
| POST | `/quotations/:id/duplicate` | QUOTATIONS | ENFORCED | quotation:create |
| POST | `/quotations/:id/mark-sent` | QUOTATIONS | ENFORCED | quotation:create |
| GET | `/quotations/:id/pdf` | QUOTATIONS | ENFORCED | quotation:read |
| GET | `/quotations/:id/revisions` | QUOTATIONS | ENFORCED | quotation:read |
| POST | `/quotations/:id/revisions` | QUOTATIONS | ENFORCED | quotation:create |
| GET | `/quotations/:id/revisions/:revisionId` | QUOTATIONS | ENFORCED | quotation:read |
| POST | `/quotations/:id/share/email` | QUOTATIONS | ENFORCED | quotation:share |
| POST | `/quotations/:id/share/whatsapp` | QUOTATIONS | ENFORCED | quotation:share |
| POST | `/quotations/preview` | QUOTATIONS | ENFORCED | quotation:create |

### ReceiptsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/receipts/:id` | RETAIL_POS | ENFORCED | sale:read |
| POST | `/receipts/:saleId/customer` | RETAIL_POS | ENFORCED | sale:create |
| GET | `/receipts/sale/:saleId` | RETAIL_POS | ENFORCED | sale:read |

### RestaurantConfigController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/branches/:branchId/config` | DINING | ENFORCED | platform:profile:read |
| PUT | `/restaurant/branches/:branchId/config` | DINING | ENFORCED | restaurant:config:manage |

### DiningAreasController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/branches/:branchId/dining-areas` | DINING | ENFORCED | platform:profile:read |
| POST | `/restaurant/branches/:branchId/dining-areas` | DINING | ENFORCED | restaurant:config:manage |
| PATCH | `/restaurant/branches/:branchId/dining-areas/:areaId` | DINING | ENFORCED | restaurant:config:manage |

### RestaurantTablesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/dining-areas/:areaId/tables` | TABLE_MANAGEMENT | ENFORCED | platform:profile:read |
| POST | `/restaurant/dining-areas/:areaId/tables` | TABLE_MANAGEMENT | ENFORCED | restaurant:config:manage |
| PATCH | `/restaurant/dining-areas/:areaId/tables/:tableId` | TABLE_MANAGEMENT | ENFORCED | restaurant:config:manage |

### KitchenStationsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/branches/:branchId/kitchen-stations` | KITCHEN | ENFORCED | platform:profile:read |
| POST | `/restaurant/branches/:branchId/kitchen-stations` | KITCHEN | ENFORCED | kitchen:station:manage |
| GET | `/restaurant/branches/:branchId/kitchen-stations/:stationId` | KITCHEN | ENFORCED | platform:profile:read |
| PATCH | `/restaurant/branches/:branchId/kitchen-stations/:stationId` | KITCHEN | ENFORCED | kitchen:station:manage |

### MenusController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/branches/:branchId/menus` | MENU_MANAGEMENT | ENFORCED | product:read |
| POST | `/restaurant/branches/:branchId/menus` | MENU_MANAGEMENT | ENFORCED | product:manage |
| PATCH | `/restaurant/branches/:branchId/menus/:menuId` | MENU_MANAGEMENT | ENFORCED | product:manage |

### MenuSectionsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/menus/:menuId/sections` | MENU_MANAGEMENT | ENFORCED | product:read |
| POST | `/restaurant/menus/:menuId/sections` | MENU_MANAGEMENT | ENFORCED | product:manage |
| PATCH | `/restaurant/menus/:menuId/sections/:sectionId` | MENU_MANAGEMENT | ENFORCED | product:manage |

### MenuItemsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/menu-sections/:sectionId/items` | MENU_MANAGEMENT | ENFORCED | product:read |
| POST | `/restaurant/menu-sections/:sectionId/items` | MENU_MANAGEMENT | ENFORCED | product:manage |
| PATCH | `/restaurant/menu-sections/:sectionId/items/:itemId` | MENU_MANAGEMENT | ENFORCED | product:manage |

### ModifiersController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/restaurant/modifier-groups` | MENU_MANAGEMENT | ENFORCED | product:read |
| POST | `/restaurant/modifier-groups` | MENU_MANAGEMENT | ENFORCED | product:manage |
| GET | `/restaurant/modifier-groups/:groupId` | MENU_MANAGEMENT | ENFORCED | product:read |
| PATCH | `/restaurant/modifier-groups/:groupId` | MENU_MANAGEMENT | ENFORCED | product:manage |

### ReturnsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/returns` | RETURNS | ENFORCED | return:read |
| POST | `/returns` | RETURNS | ENFORCED | return:create |
| GET | `/returns/:id` | RETURNS | ENFORCED | return:read |
| POST | `/returns/:id/cancel` | RETURNS | ENFORCED | return:create |
| POST | `/returns/:id/receipt` | RETURNS | ENFORCED | return:read |
| POST | `/returns/:id/retry-sync` | RETURNS | ENFORCED | return:read |
| POST | `/returns/approve` | RETURNS | ENFORCED | return:create |
| POST | `/returns/preview` | RETURNS | ENFORCED | return:create |

### ReturnsSalesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/sales/:id/return-eligibility` | RETURNS | ENFORCED | return:read |
| GET | `/sales/:id/returnable-items` | RETURNS | ENFORCED | return:read |
| GET | `/sales/:id/returns` | RETURNS | ENFORCED | return:read |

### RolesController

Tenant role management (Phase 1.5.5). Gated on the `USERS` module and the
`user:manage` permission — never on a role *name*, so a tenant that renames its
administrator role, or builds its own, keeps working.

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/roles` | USERS | ENFORCED | user:manage |
| POST | `/roles` | USERS | ENFORCED | user:manage |
| GET | `/roles/:roleId` | USERS | ENFORCED | user:manage |
| PATCH | `/roles/:roleId` | USERS | ENFORCED | user:manage |
| POST | `/roles/:roleId/archive` | USERS | ENFORCED | user:manage |
| PUT | `/roles/:roleId/permissions` | USERS | ENFORCED | user:manage |

### UserRolesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| PUT | `/users/:userId/role` | USERS | ENFORCED | user:manage |
| GET | `/users/:userId/effective-permissions` | USERS | ENFORCED | user:manage |

### SalesController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/sales` | SHARED_CORE | shared-core | sale:read |
| GET | `/sales/:id` | SHARED_CORE | shared-core | sale:read |
| POST | `/sales/:id/retry-sync` | RETAIL_POS | ENFORCED | sale:create |
| POST | `/sales/:id/sync` | RETAIL_POS | ENFORCED | sale:create |
| POST | `/sales/complete` | RETAIL_POS | ENFORCED | sale:create |
| POST | `/sales/draft` | RETAIL_POS | ENFORCED | sale:create |
| GET | `/sales/report` | SHARED_CORE | shared-core | sale:read |

### SettingsController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/settings` | SETTINGS | ENFORCED | — |
| PUT | `/settings` | SETTINGS | ENFORCED | settings:manage |
| DELETE | `/settings/document-profile/logo` | SETTINGS | ENFORCED | settings:manage |
| POST | `/settings/document-profile/logo` | SETTINGS | ENFORCED | settings:manage |
| DELETE | `/settings/document-profile/signature` | SETTINGS | ENFORCED | settings:manage |
| POST | `/settings/document-profile/signature` | SETTINGS | ENFORCED | settings:manage |
| DELETE | `/settings/document-profile/stamp` | SETTINGS | ENFORCED | settings:manage |
| POST | `/settings/document-profile/stamp` | SETTINGS | ENFORCED | settings:manage |
| POST | `/settings/reset` | SETTINGS | ENFORCED | settings:manage |

### SuppliersController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/suppliers` | SUPPLIERS | ENFORCED | supplier:read |
| POST | `/suppliers` | SUPPLIERS | ENFORCED | supplier:manage |
| DELETE | `/suppliers/:id` | SUPPLIERS | ENFORCED | supplier:delete |
| GET | `/suppliers/:id` | SUPPLIERS | ENFORCED | supplier:read |
| PATCH | `/suppliers/:id` | SUPPLIERS | ENFORCED | supplier:manage |
| DELETE | `/suppliers/:id/quickbooks-mapping` | SUPPLIERS | ENFORCED | supplier:qb:map |
| POST | `/suppliers/:id/quickbooks-mapping` | SUPPLIERS | ENFORCED | supplier:qb:map |
| POST | `/suppliers/import/commit` | SUPPLIERS | ENFORCED | supplier:manage |
| POST | `/suppliers/import/preview` | SUPPLIERS | ENFORCED | supplier:manage |
| GET | `/suppliers/import/template` | SUPPLIERS | ENFORCED | supplier:manage |

### SyncController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/sync/logs` | QUICKBOOKS | ENFORCED | sync:read |
| POST | `/sync/products/refresh` | QUICKBOOKS | ENFORCED | sync:read |
| POST | `/sync/sales/:id/retry` | QUICKBOOKS | ENFORCED | sync:read |
| GET | `/sync/status` | QUICKBOOKS | ENFORCED | — |

### UsersController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/users` | USERS | ENFORCED | user:manage |
| POST | `/users` | USERS | ENFORCED | user:manage |
| GET | `/users/:id` | USERS | ENFORCED | user:manage |

### UserBranchAccessController

| Method | Path | Module | Guard | Permission |
|---|---|---|---|---|
| GET | `/users/:userId/branch-access` | USERS | ENFORCED | user:manage |
| PUT | `/users/:userId/branch-access/:branchId` | USERS | ENFORCED | user:manage |
| DELETE | `/users/:userId/branch-access/:branchId` | USERS | ENFORCED | user:manage |
