import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { DiningAreasController } from './dining-areas.controller';
import { DiningService } from './dining.service';
import { RestaurantTablesController } from './restaurant-tables.controller';

@Module({
  imports: [AuditLogModule],
  controllers: [DiningAreasController, RestaurantTablesController],
  providers: [DiningService],
  exports: [DiningService],
})
export class DiningModule {}
