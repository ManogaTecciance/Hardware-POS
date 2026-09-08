import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { SettingsModule } from '../settings/settings.module';
import { SyncModule } from '../sync/sync.module';
import { ReturnsController } from './returns.controller';
import { ReturnsSalesController } from './returns-sales.controller';
import { ReturnsRepository } from './returns.repository';
import { ReturnsService } from './returns.service';

/**
 * `ProvidersModule` is imported here (Slice 6B) so `ReturnsService` can resolve the
 * accounting provider the ORIGINAL SALE was filed under. `SyncModule` stays: the
 * service still owns retry/requeue, which is sync orchestration rather than a
 * provider concern.
 */
@Module({
  imports: [AuthModule, SettingsModule, SyncModule, ProvidersModule],
  controllers: [ReturnsController, ReturnsSalesController],
  providers: [ReturnsService, ReturnsRepository],
  exports: [ReturnsService],
})
export class ReturnsModule {}
