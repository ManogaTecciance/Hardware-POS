import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../settings/settings.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PdfService } from './pdf.service';

@Module({
  // D154 — PlatformModule for the business profile, which decides whose
  // sample goods a document preview is illustrated with. Imported explicitly
  // even though it is @Global(): global only means "no re-import once it is in
  // the graph", and something still has to put it there for a smaller graph.
  imports: [SettingsModule, AuditLogModule, PlatformModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, PdfService],
  exports: [DocumentsService, PdfService],
})
export class DocumentsModule {}
