import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ModuleAccessGuard } from './common/guards/module-access.guard';
import { BranchScopeGuard } from './common/guards/branch-scope.guard';
import { StorageModule } from './common/storage/storage.module';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { SalesModule } from './modules/sales/sales.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { DiscountsModule } from './modules/discounts/discounts.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReceiptsModule } from './modules/receipts/receipts.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { QuickBooksModule } from './modules/quickbooks/quickbooks.module';
import { SyncModule } from './modules/sync/sync.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { BranchesModule } from './modules/branches/branches.module';
import { PlatformModule } from './modules/platform/platform.module';
import { RestaurantModule } from './modules/restaurant/restaurant.module';
import { MenuModule } from './modules/menu/menu.module';
import { DiningModule } from './modules/dining/dining.module';
import { TableSessionsModule } from './modules/table-sessions/table-sessions.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { TakeawayModule } from './modules/takeaway/takeaway.module';
import { BillingModule } from './modules/billing/billing.module';
import { RestaurantReportsModule } from './modules/restaurant-reports/restaurant-reports.module';
import { DeliveryHubModule } from './modules/delivery-hub/delivery-hub.module';
import { RestaurantOrdersModule } from './modules/restaurant-orders/restaurant-orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    StorageModule,
    // Global: AuthController attaches AuthThrottleInterceptor without needing to
    // import the rate-limiting plumbing it otherwise has no interest in.
    ThrottlingModule,
    RealtimeModule,
    PrismaModule,
    // Global: ModuleAccessGuard and (from Slice 5) the provider factories resolve
    // the tenant's business profile, so BusinessProfileService must be reachable
    // without every feature module importing PlatformModule.
    PlatformModule,
    HealthModule,
    AuthModule,
    RolesModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    CustomersModule,
    SuppliersModule,
    SalesModule,
    ReturnsModule,
    QuotationsModule,
    DiscountsModule,
    PaymentsModule,
    ReceiptsModule,
    DocumentsModule,
    QuickBooksModule,
    SyncModule,
    SettingsModule,
    AuditLogModule,
    DashboardModule,
    BranchesModule,
    RestaurantModule,
    MenuModule,
    DiningModule,
    TableSessionsModule,
    KitchenModule,
    TakeawayModule,
    BillingModule,
    RestaurantReportsModule,
    DeliveryHubModule,
    RestaurantOrdersModule,
  ],
  providers: [
    // Order matters: authenticate first (populates request.user), then authorize.
    // ModuleAccessGuard runs before BranchScopeGuard because there is no point
    // validating branch context for a module the tenant does not have at all.
    // Routes without any of the four metadata keys pass through untouched.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ModuleAccessGuard },
    { provide: APP_GUARD, useClass: BranchScopeGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
