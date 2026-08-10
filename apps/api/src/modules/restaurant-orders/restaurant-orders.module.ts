import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { RestaurantOrdersService } from './restaurant-orders.service';

@Module({
  imports: [PrismaModule, AuditLogModule],
  controllers: [RestaurantOrdersController],
  providers: [RestaurantOrdersService],
})
export class RestaurantOrdersModule {}
