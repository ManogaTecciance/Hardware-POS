import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PlatformModule } from '../platform/platform.module';
import { CatalogueEntriesController } from './catalogue-entries.controller';
import { CollectionController } from './collection.controller';
import { CollectionSectionsController } from './collection-sections.controller';
import { CollectionsController } from './collections.controller';
import { CatalogueService } from './catalogue.service';

/** D62 — collections/sections/entries: the successor authoring surface. */
@Module({
  // PlatformModule: the D66 capability gate reads the effective profile.
  imports: [AuditLogModule, PlatformModule],
  controllers: [
    CollectionsController,
    CollectionController,
    CollectionSectionsController,
    CatalogueEntriesController,
  ],
  providers: [CatalogueService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
