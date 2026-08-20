import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { PrintAgentController } from './print-agent.controller';
import { PrintAgentGuard } from './print-agent.guard';
import { PrintAgentService } from './print-agent.service';
import { PrintDispatcherService } from './print-dispatcher.service';
import { PrinterDiscoveryService } from './printer-discovery.service';
import { PrintWorkerService } from './print-worker.service';
import { PrintingController } from './printing.controller';
import { PrintingService } from './printing.service';

/**
 * D67 — auto-printing: the outbox drainer, its worker, and the operator's
 * manual controls.
 *
 * Deliberately depends on nothing but Prisma and Settings: printing is an
 * edge concern that must never become a dependency of order intake. Intake
 * writes queue rows (already did for KOTs) and calls `kick()`; this module
 * turns rows into paper.
 */
@Module({
  imports: [SettingsModule],
  controllers: [PrintingController, PrintAgentController],
  providers: [
    PrintDispatcherService,
    PrintingService,
    PrintWorkerService,
    PrinterDiscoveryService,
    PrintAgentService,
    PrintAgentGuard,
  ],
  exports: [PrintingService, PrintDispatcherService, PrinterDiscoveryService, PrintAgentService],
})
export class PrintingModule {}
