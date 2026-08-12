import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../prisma/prisma.service';

export type DocumentType =
  | 'SALE'
  | 'RETURN'
  | 'QUOTATION'
  // Phase 5 additions — table sessions and restaurant orders each get
  // their own per-tenant sequence so waiters can talk about "TS-47" out
  // loud, and order numbers don't collide with sale numbers.
  | 'TABLE_SESSION'
  | 'RESTAURANT_ORDER'
  // D44 — Purchase Receipts (Receive Stock / GRN). Kept as its own tenant
  // sequence so the "RCV-000042" identifiers do not collide with sales,
  // returns or quotations, and so gaps caused by aborted transactions are
  // impossible on the same guarantees as every other document type.
  | 'RECEIPT';

/** A Prisma client or an interactive-transaction client — both can run raw SQL. */
type PrismaLike = PrismaService | Prisma.TransactionClient;

/**
 * Atomically reserve the next sequence number for a tenant's document type.
 *
 * Uses a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so it is safe
 * under concurrency (two registers completing a sale at the same instant get
 * distinct numbers) and immune to deletions (never reuses a number) — unlike
 * the old `count() + 1` scheme. Call it inside the same transaction as the
 * document insert; as a single statement it is atomic on its own too.
 */
export async function nextDocumentNumber(
  client: PrismaLike,
  tenantId: string,
  docType: DocumentType,
): Promise<number> {
  const rows = await client.$queryRaw<Array<{ value: number }>>(Prisma.sql`
    INSERT INTO "DocumentSequence" ("tenantId", "docType", "value")
    VALUES (${tenantId}, ${docType}, 1)
    ON CONFLICT ("tenantId", "docType")
    DO UPDATE SET "value" = "DocumentSequence"."value" + 1
    RETURNING "value"
  `);
  return Number(rows[0].value);
}

/** Zero-padded sequence string, e.g. 7 → "000007". */
export function padSequence(value: number): string {
  return String(value).padStart(6, '0');
}
