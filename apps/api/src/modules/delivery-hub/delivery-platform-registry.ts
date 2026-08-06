import { Injectable, NotImplementedException } from '@nestjs/common';

import { DeliveryPlatformAdapter } from './delivery-platform-adapter';
import { MockDeliveryPlatformAdapter } from './mock-delivery-platform.adapter';

/**
 * Factory-style resolver. New adapters register here; the Ordering flow asks
 * for one by `kind` and never new-instances an adapter directly.
 *
 * Uber Eats and PickMe Food register as `NOT_IMPLEMENTED` throws — the schema
 * accepts them as valid `DeliveryPlatformKind` values (so a tenant can be
 * provisioned for a platform that isn't wired yet), but the webhook will
 * refuse until an adapter lands.
 */
@Injectable()
export class DeliveryPlatformRegistry {
  constructor(private readonly mock: MockDeliveryPlatformAdapter) {}

  get(kind: string): DeliveryPlatformAdapter {
    switch (kind) {
      case 'MOCK':
        return this.mock;
      case 'UBER_EATS':
      case 'PICKME_FOOD':
      case 'DOORDASH':
      case 'OTHER':
        throw new NotImplementedException(
          `Delivery adapter '${kind}' is not implemented. Only MOCK ships in this repo.`,
        );
      default:
        throw new NotImplementedException(`Unknown delivery platform kind: ${kind}`);
    }
  }
}
