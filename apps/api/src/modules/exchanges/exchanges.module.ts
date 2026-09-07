import { Module } from '@nestjs/common';

import { ReturnsModule } from '../returns/returns.module';
import { SalesModule } from '../sales/sales.module';
import { ExchangesController } from './exchanges.controller';
import { ExchangesRepository } from './exchanges.repository';
import { ExchangesService } from './exchanges.service';

/**
 * D107 — the exchange module imports the two it composes and adds nothing else.
 *
 * No `ProvidersModule`, no `SyncModule`, no `SettingsModule`: this module
 * resolves no provider, enqueues no sync and reads no setting. Everything that
 * needs them is reached through `ReturnsService` and `SalesService`, which
 * already own those relationships. Importing them here would be the beginning of
 * a second money path, which is the one thing the record forbids.
 */
@Module({
  imports: [ReturnsModule, SalesModule],
  controllers: [ExchangesController],
  providers: [ExchangesService, ExchangesRepository],
  exports: [ExchangesService],
})
export class ExchangesModule {}
