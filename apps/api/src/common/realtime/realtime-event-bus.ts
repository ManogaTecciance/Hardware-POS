import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * Phase 4 (D7) / Phase 13. Event-emission abstraction for real-time
 * consumers (KDS, floor view, waiter tablet).
 *
 * Ships as an abstraction only, matching D39's rate-limit approach: the
 * event stream exists, publishers use it today, and a Socket.IO / SSE
 * adapter can subscribe without changing any of the emitting code.
 *
 * Deliberately in-process for now. When multiple API replicas land, the
 * subscriber gets a Redis-backed distributor (open decision O2) without
 * publishers changing.
 */

export type RealtimeEventType =
  | 'restaurant.round.submitted'
  | 'restaurant.order.status.changed'
  | 'restaurant.table.status.changed'
  | 'kitchen.ticket.printed'
  | 'kitchen.ticket.failed';

export interface RealtimeEvent<T = unknown> {
  type: RealtimeEventType;
  tenantId: string;
  branchId: string;
  entityId: string;
  payload: T;
  emittedAt: number;
}

@Injectable()
export class RealtimeEventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger(RealtimeEventBus.name);

  constructor() {
    // Cap listener count; a runaway subscribe/no-unsubscribe pattern would
    // otherwise silently degrade to logs full of MaxListenersExceededWarning.
    this.emitter.setMaxListeners(50);
  }

  emit<T>(event: RealtimeEvent<T>): void {
    this.emitter.emit(event.type, event);
    // Tenant-scoped channel for a future selective subscription.
    this.emitter.emit(`${event.type}:${event.tenantId}`, event);
  }

  subscribe<T>(type: RealtimeEventType, handler: (event: RealtimeEvent<T>) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  /**
   * Subscribe to every event for a specific tenant. Used by the future
   * WebSocket gateway to fan events out to that tenant's connected clients.
   */
  subscribeForTenant(
    tenantId: string,
    handler: (event: RealtimeEvent) => void,
  ): () => void {
    const types: RealtimeEventType[] = [
      'restaurant.round.submitted',
      'restaurant.order.status.changed',
      'restaurant.table.status.changed',
      'kitchen.ticket.printed',
      'kitchen.ticket.failed',
    ];
    const wrap = (event: RealtimeEvent) => {
      if (event.tenantId !== tenantId) return;
      handler(event);
    };
    for (const t of types) this.emitter.on(t, wrap);
    return () => {
      for (const t of types) this.emitter.off(t, wrap);
    };
  }
}
