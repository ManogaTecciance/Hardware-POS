import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../settings/settings.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsRepository } from './promotions.repository';
import { PromotionsService } from './promotions.service';
import { RestaurantPromotionPricingService } from './restaurant-promotion-pricing.service';

/**
 * D45 — Scheduled auto-apply promotions.
 *
 * The pure `promotions.evaluator.ts` is intentionally NOT registered as a
 * provider — it has no injections, so consumers (this service and the POS
 * Catalogue) import the function directly. Exporting `PromotionsService`
 * lets the Restaurant POS Catalogue reuse its list/evaluation entry points.
 *
 * `RestaurantPromotionPricingService` is exported for the two restaurant
 * settlement paths (table-session close, takeaway settle) and their previews.
 */
@Module({
  // PlatformModule supplies BusinessProfileService, which D56 channel
  // validation reads. It imports only AuditLogModule, so there is no cycle.
  // SettingsModule supplies the tenant's time zone (D139), which the
  // evaluator needs to read a promotion's day/time window on the operator's
  // clock. It imports only AuditLogModule, so there is no cycle.
  imports: [AuditLogModule, PlatformModule, SettingsModule],
  controllers: [PromotionsController],
  providers: [PromotionsService, PromotionsRepository, RestaurantPromotionPricingService],
  exports: [PromotionsService, PromotionsRepository, RestaurantPromotionPricingService],
})
export class PromotionsModule {}
