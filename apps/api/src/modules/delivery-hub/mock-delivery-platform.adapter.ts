import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { DeliveryPlatformAdapter, NormalisedExternalOrder } from './delivery-platform-adapter';

/**
 * Mock adapter (Phase 10). Accepts JSON of the shape:
 *
 *   { orderRef: string, total?: number, items: [{name, quantity, unitPrice?, externalItemRef?}] }
 *
 * Every accept/reject/mark-ready/mark-completed call just logs — there is no
 * real platform to notify.
 */
@Injectable()
export class MockDeliveryPlatformAdapter implements DeliveryPlatformAdapter {
  readonly kind = 'MOCK';
  readonly description = 'Mock delivery platform (dev/test)';
  private readonly logger = new Logger(MockDeliveryPlatformAdapter.name);

  normalizeOrder(payload: unknown): NormalisedExternalOrder {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Mock payload must be an object');
    }
    const p = payload as {
      orderRef?: unknown;
      total?: unknown;
      items?: unknown;
    };
    if (typeof p.orderRef !== 'string' || p.orderRef.length === 0) {
      throw new BadRequestException('Mock payload requires a string `orderRef`');
    }
    if (!Array.isArray(p.items) || p.items.length === 0) {
      throw new BadRequestException('Mock payload requires a non-empty `items` array');
    }
    return {
      externalOrderRef: p.orderRef,
      externalTotal: typeof p.total === 'number' ? p.total : undefined,
      items: p.items.map((raw, i) => {
        const item = raw as {
          name?: unknown;
          quantity?: unknown;
          unitPrice?: unknown;
          externalItemRef?: unknown;
        };
        if (typeof item.name !== 'string') {
          throw new BadRequestException(`items[${i}].name must be a string`);
        }
        if (typeof item.quantity !== 'number' || item.quantity <= 0) {
          throw new BadRequestException(`items[${i}].quantity must be a positive number`);
        }
        return {
          externalItemRef: typeof item.externalItemRef === 'string' ? item.externalItemRef : undefined,
          name: item.name,
          quantity: item.quantity,
          unitPrice: typeof item.unitPrice === 'number' ? item.unitPrice : undefined,
        };
      }),
      raw: payload as import('@hardware-pos/database').Prisma.InputJsonValue,
    };
  }

  async acceptOrder(externalOrderRef: string): Promise<void> {
    this.logger.log(`[MOCK] accept ${externalOrderRef}`);
  }
  async rejectOrder(externalOrderRef: string, reason: string): Promise<void> {
    this.logger.log(`[MOCK] reject ${externalOrderRef} — ${reason}`);
  }
  async markReady(externalOrderRef: string): Promise<void> {
    this.logger.log(`[MOCK] ready ${externalOrderRef}`);
  }
  async markCompleted(externalOrderRef: string): Promise<void> {
    this.logger.log(`[MOCK] completed ${externalOrderRef}`);
  }
}
