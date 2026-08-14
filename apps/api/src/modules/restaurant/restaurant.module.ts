import { ProductsModule } from '../products/products.module';
import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { KitchenStationsController } from './kitchen-stations.controller';
import { KitchenStationsService } from './kitchen-stations.service';
import { PosCatalogueController } from './pos-catalogue.controller';
import { PosCatalogueService } from './pos-catalogue.service';
import { RestaurantConfigController } from './restaurant-config.controller';
import { RestaurantConfigService } from './restaurant-config.service';

@Module({
  // D45 — `PromotionsModule` is imported (not just the app-level registration)
  // so the POS Catalogue service can consume `PromotionsRepository` and the
  // evaluator through the DI container rather than reaching into another
  // module's internals.
  imports: [AuditLogModule, PromotionsModule, ProductsModule],
  controllers: [
    RestaurantConfigController,
    KitchenStationsController,
    PosCatalogueController,
  ],
  providers: [RestaurantConfigService, KitchenStationsService, PosCatalogueService],
  exports: [RestaurantConfigService, KitchenStationsService],
})
export class RestaurantModule {}
