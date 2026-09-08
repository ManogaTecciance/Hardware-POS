import { Prisma, SyncStatus } from '@hardware-pos/database';

/**
 * D63 — mirror a QuickBooks identity/sync-state write into
 * `ExternalEntityRef` (convergence plan §8.10 step 2: DUAL-WRITE).
 *
 * Phase 6's staging: the legacy vendor columns remain authoritative and keep
 * being written exactly as before; every such write ALSO lands here, so the
 * satellite fills to completeness. The read switch (step 5) happens only
 * after a production reconciliation cycle proves the two agree — this
 * function is what makes that proof possible.
 *
 * Upsert on the (tenant, provider, entityType, localId) identity. A write
 * that carries only sync state (PENDING/FAILED, no external id yet) still
 * creates the row: "we tried and failed" is state the satellite must hold,
 * or the reconciliation would read absence as never-attempted.
 */

export type ExternalRefEntityType =
  | 'PRODUCT'
  | 'PRODUCT_CATEGORY'
  | 'CUSTOMER'
  | 'SUPPLIER'
  | 'SALE'
  | 'PAYMENT'
  | 'RETURN'
  | 'REFUND_PAYMENT';

export const QUICKBOOKS_PROVIDER = 'QUICKBOOKS';

export interface ExternalRefPatch {
  externalId?: string | null;
  externalType?: string | null;
  syncStatus?: SyncStatus;
  syncError?: string | null;
  lastSyncedAt?: Date | null;
}

type Db = Prisma.TransactionClient | { externalEntityRef: Prisma.TransactionClient['externalEntityRef'] };

export async function mirrorExternalRef(
  db: Db,
  tenantId: string,
  entityType: ExternalRefEntityType,
  localId: string,
  patch: ExternalRefPatch,
): Promise<void> {
  const data = {
    ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
    ...(patch.externalType !== undefined ? { externalType: patch.externalType } : {}),
    ...(patch.syncStatus !== undefined ? { syncStatus: patch.syncStatus } : {}),
    ...(patch.syncError !== undefined ? { syncError: patch.syncError } : {}),
    ...(patch.lastSyncedAt !== undefined ? { lastSyncedAt: patch.lastSyncedAt } : {}),
  };
  await db.externalEntityRef.upsert({
    where: {
      tenantId_provider_entityType_localId: {
        tenantId,
        provider: QUICKBOOKS_PROVIDER,
        entityType,
        localId,
      },
    },
    update: data,
    create: {
      tenantId,
      provider: QUICKBOOKS_PROVIDER,
      entityType,
      localId,
      ...data,
    },
  });
}
