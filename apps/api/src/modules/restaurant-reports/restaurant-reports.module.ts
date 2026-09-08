import { Module } from '@nestjs/common';

import { RestaurantReportsController } from './restaurant-reports.controller';
import { RestaurantReportsService } from './restaurant-reports.service';

@Module({
  controllers: [RestaurantReportsController],
  providers: [RestaurantReportsService],
  exports: [RestaurantReportsService],
})
export class RestaurantReportsModule {}
