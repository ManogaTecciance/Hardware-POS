import { Global, Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { BusinessProfileRepository } from './business-profile.repository';
import { BusinessProfileService } from './business-profile.service';
import { PlatformController } from './platform.controller';

/**
 * Platform business-profile module.
 *
 * `@Global()` because `ModuleAccessGuard` is registered as an `APP_GUARD` and
 * every future feature module will need `BusinessProfileService` to resolve its
 * own gating; making it global avoids importing this module into all of them (the
 * same reason `StorageModule` is global).
 */
@Global()
@Module({
  imports: [AuditLogModule],
  controllers: [PlatformController],
  providers: [BusinessProfileService, BusinessProfileRepository],
  exports: [BusinessProfileService],
})
export class PlatformModule {}
