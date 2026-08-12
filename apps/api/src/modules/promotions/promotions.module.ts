import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsRepository } from './promotions.repository';
import { PromotionsService } from './promotions.service';

/**
 * D45 — Scheduled auto-apply promotions.
 *
 * The pure `promotions.evaluator.ts` is intentionally NOT registered as a
 * provider — it has no injections, so consumers (this service and the POS
 * Catalogue) import the function directly. Exporting `PromotionsService`
 * lets the Restaurant POS Catalogue reuse its list/evaluation entry points.
 */
@Module({
  imports: [AuditLogModule],
  controllers: [PromotionsController],
  providers: [PromotionsService, PromotionsRepository],
  exports: [PromotionsService, PromotionsRepository],
})
export class PromotionsModule {}
