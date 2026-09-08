import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { DeliveryHubService } from './delivery-hub.service';
import { DeliveryPlatformRegistry } from './delivery-platform-registry';
import { DeliveryWebhookController } from './delivery-webhook.controller';
import { MockDeliveryPlatformAdapter } from './mock-delivery-platform.adapter';

@Module({
  imports: [AuditLogModule, KitchenModule],
  controllers: [DeliveryWebhookController],
  providers: [DeliveryHubService, DeliveryPlatformRegistry, MockDeliveryPlatformAdapter],
  exports: [DeliveryHubService, DeliveryPlatformRegistry],
})
export class DeliveryHubModule {}
