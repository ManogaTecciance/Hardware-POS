import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { KitchenStationsController } from './kitchen-stations.controller';
import { KitchenStationsService } from './kitchen-stations.service';
import { RestaurantConfigController } from './restaurant-config.controller';
import { RestaurantConfigService } from './restaurant-config.service';

@Module({
  imports: [AuditLogModule],
  controllers: [RestaurantConfigController, KitchenStationsController],
  providers: [RestaurantConfigService, KitchenStationsService],
  exports: [RestaurantConfigService, KitchenStationsService],
})
export class RestaurantModule {}
