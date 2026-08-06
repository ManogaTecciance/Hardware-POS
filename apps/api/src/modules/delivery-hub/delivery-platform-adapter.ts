import type { Prisma } from '@hardware-pos/database';

/**
 * Phase 10 (D9). The delivery-platform port.
 *
 * Concrete adapters (Uber Eats, PickMe Food, DoorDash, …) implement this.
 * The Mock adapter is the only implementation shipped in this repo; per
 * user instruction (and D9), no external platform is integrated here.
 *
 * The Ordering module talks to this port and never to a specific adapter,
 * so KOT generation, audit and idempotency are identical for a dine-in
 * round and a delivery order.
 */
export interface DeliveryPlatformAdapter {
  readonly kind: string;
  /** Human-readable description for logs and admin. */
  readonly description: string;

  /**
   * Parse a raw webhook payload into a normalised ExternalOrder shape. Called
   * synchronously from the webhook receiver; MUST NOT reach the network. If
   * the payload cannot be parsed, throw — the caller records the raw payload
   * and answers 4xx to the platform.
   */
  normalizeOrder(payload: unknown): NormalisedExternalOrder;

  /**
   * Answer the platform's "accept" query. In production this hits the
   * platform's REST API; the Mock adapter does nothing.
   */
  acceptOrder(externalOrderRef: string): Promise<void>;

  /** Answer "reject" — customer refund flow lives on the platform side. */
  rejectOrder(externalOrderRef: string, reason: string): Promise<void>;

  markReady(externalOrderRef: string): Promise<void>;

  markCompleted(externalOrderRef: string): Promise<void>;
}

export interface NormalisedExternalOrder {
  externalOrderRef: string;
  externalTotal?: number;
  items: {
    externalItemRef?: string;
    /** Free-text name for the audit trail; menu-matching is a separate step. */
    name: string;
    quantity: number;
    unitPrice?: number;
  }[];
  raw: Prisma.InputJsonValue;
}
