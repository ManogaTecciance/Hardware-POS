import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrintDispatcherService } from './print-dispatcher.service';

/**
 * D67 — the safety net behind the post-commit `kick()`.
 *
 * The kick covers the happy path (an order was just placed); this interval
 * covers everything else: a printer that was off when the order landed and
 * came back, a job queued while the process was restarting, and the retry
 * backoff (a failed attempt is re-queued and printed on a later tick, so the
 * interval IS the delay between tries).
 *
 * Modelled on `SyncWorkerService`. Disable with `PRINT_WORKER_ENABLED=false`
 * — which the integration harness does, so specs drive `drain()` explicitly
 * and never race a timer.
 */
@Injectable()
export class PrintWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PrintWorkerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dispatcher: PrintDispatcherService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<string>('PRINT_WORKER_ENABLED', 'true') !== 'false';
    this.intervalMs = Number(configService.get<string>('PRINT_WORKER_INTERVAL_MS', '5000'));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Print worker disabled (PRINT_WORKER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.dispatcher.drain().catch((err) =>
        this.logger.error(`Print drain failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`Print worker started (interval ${this.intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
