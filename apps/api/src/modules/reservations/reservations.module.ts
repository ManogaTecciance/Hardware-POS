import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

/** D47 — table reservations by timeslot; feeds the web Calendar page. */
@Module({
  imports: [AuditLogModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
