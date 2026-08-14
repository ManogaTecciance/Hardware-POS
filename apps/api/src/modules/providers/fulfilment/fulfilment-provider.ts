import { FulfilmentKind, Prisma } from '@hardware-pos/database';

import type { OpenTableReleaseSummary } from '../../dining/dining.service';
import type { ProjectedSaleItem } from '../../restaurant/settlement-projection';

/**
 * D61 — the third provider axis (convergence plan §4.5, Phase 4), alongside
 * `InventoryProvider` and `AccountingProvider` (D28).
 *
 * A fulfilment provider owns HOW a sale comes into being — the operational
 * lifecycle between "the customer wants this" and "the money settled". The
 * settlement document itself (`Sale`/`SaleItem`, D58) is Layer-1 invariant
 * core: every provider projects into it, which is why a new vertical's
 * lifecycle (an appointment, a room-night, a repair job) inherits reporting,
 * receipts, returns and accounting without touching any of them.
 *
 * ## Why the work-unit ref is a tagged union, not an entity id
 *
 * TABLE_SERVICE has a persisted work unit (the `TableSession`); IMMEDIATE
 * deliberately has none — a counter sale's "work unit" is the priced cart in
 * the request, and inventing a row for it would make retail pay for
 * concurrency machinery it never uses (plan §3.3). The union makes both
 * shapes first-class instead of pretending one is the other. A future
 * provider adds its own variant (`{ kind: 'APPOINTMENT', appointmentId }`).
 */
export type WorkUnitRef =
  | { kind: 'TABLE_SESSION'; sessionId: string }
  | { kind: 'CART'; lines: ProjectedSaleItem[] };

/** What releasing resources reported — shape owned by each provider. */
export interface ReleaseOutcome {
  /** D49/D50 — present when closing an open table released members. */
  openTableRelease?: OpenTableReleaseSummary;
}

export interface FulfilmentProvider {
  readonly kind: FulfilmentKind;

  /**
   * Every not-yet-settled line for the work unit, in the universal
   * settlement shape (D58's projection). The caller writes them onto the
   * Sale inside ITS transaction — collection and persistence stay separable
   * so the sum invariant can sit between them.
   */
  collectSettlementLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ProjectedSaleItem[]>;

  /**
   * Release the domain resources the work unit held — free the table,
   * dissolve the open-table arrangement; check out the room, one day.
   * No-op for IMMEDIATE. Runs in the settlement transaction so "bill
   * settled" and "resources released" cannot be observed apart.
   */
  releaseResources(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ref: WorkUnitRef,
  ): Promise<ReleaseOutcome>;
}
