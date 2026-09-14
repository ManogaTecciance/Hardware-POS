/**
 * D175 — what a customer's store credit is, in one place.
 *
 * ## The gap this closes
 *
 * `refundMethod = 'STORE_CREDIT'` was a label on a return and nothing else. No
 * balance was recorded, the customer screen's "Available credit" is a different
 * figure entirely (`creditLimit - outstandingCredit`, how much they may buy ON
 * ACCOUNT), and nothing checked a balance when store credit was tendered.
 *
 * ## The balance is a SUM, never a column
 *
 * Entries are append-only and signed: positive issues, negative redeems. The
 * balance is `SUM(amount)`, so it cannot drift from its own history because it
 * IS its own history. Nothing here updates or deletes an entry; a correction is
 * an offsetting `ADJUSTMENT`, which leaves the trail intact.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, StoreCreditReason } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/** Anything that can run a query: the service, or a caller's transaction. */
type Db = Pick<PrismaService, 'storeCreditEntry'> | Prisma.TransactionClient;

export interface StoreCreditEntryView {
  id: string;
  amount: number;
  reason: StoreCreditReason;
  returnId: string | null;
  saleId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Money is Decimal on the wire and a number in the domain. */
function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  return value == null ? 0 : Number(value);
}

/** Two decimal places: a balance is currency, not a float. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class StoreCreditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the shop owes this customer.
   *
   * Aggregated in the database rather than by reading rows and adding them in
   * Node: a customer who has traded for years should not cost a page load
   * proportional to their history.
   */
  async balanceFor(tenantId: string, customerId: string): Promise<number> {
    const result = await this.prisma.storeCreditEntry.aggregate({
      where: { tenantId, customerId },
      _sum: { amount: true },
    });
    return round2(toNumber(result._sum.amount));
  }

  /**
   * Balances for a page of customers, in ONE query.
   *
   * The list screen shows a column of these. One aggregate per row is how a
   * customer list starts timing out at a few hundred rows.
   *
   * Customers with no entries are absent from the map rather than present as
   * zero, so the caller decides what "never had store credit" looks like —
   * which is not always the same as a balance of nothing.
   */
  async balancesFor(tenantId: string, customerIds: string[]): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.prisma.storeCreditEntry.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customerIds } },
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.customerId, round2(toNumber(r._sum.amount))]));
  }

  /** The customer's entries, newest first. The answer to "where did this come from?". */
  async historyFor(
    tenantId: string,
    customerId: string,
    take = 100,
  ): Promise<StoreCreditEntryView[]> {
    const rows = await this.prisma.storeCreditEntry.findMany({
      where: { tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        amount: true,
        reason: true,
        returnId: true,
        saleId: true,
        note: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({ ...r, amount: toNumber(r.amount) }));
  }

  /**
   * Credit a customer for a return refunded as store credit.
   *
   * `db` is the CALLER's transaction wherever there is one. A return that
   * committed its money and then failed to credit the customer is the exact
   * failure this decision exists to prevent, so the entry has to land or fail
   * with the return, not beside it.
   *
   * A duplicate is not an error. `@@unique([returnId])` makes the database the
   * authority on "credited once", and a retried return reaching here a second
   * time has already done what it came to do — raising would turn a successful
   * retry into a failure.
   */
  async issueForReturn(
    db: Db,
    input: {
      tenantId: string;
      customerId: string;
      returnId: string;
      amount: number;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    if (input.amount <= 0) return;
    try {
      await db.storeCreditEntry.create({
        data: {
          tenantId: input.tenantId,
          customerId: input.customerId,
          returnId: input.returnId,
          amount: round2(input.amount),
          reason: StoreCreditReason.RETURN_REFUND,
          createdByUserId: input.createdByUserId ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return; // already credited for this return
      }
      throw error;
    }
  }

  /**
   * Spend store credit against a sale.
   *
   * Refuses more than the customer holds. The check and the write are in the
   * caller's transaction on purpose: read-then-write across two transactions
   * lets two tills both see the same balance and both spend it.
   */
  async redeemForSale(
    db: Prisma.TransactionClient,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      amount: number;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    if (input.amount <= 0) return;
    const held = await db.storeCreditEntry.aggregate({
      where: { tenantId: input.tenantId, customerId: input.customerId },
      _sum: { amount: true },
    });
    const balance = round2(toNumber(held._sum.amount));
    if (round2(input.amount) > balance) {
      throw new BadRequestException(
        `Store credit is ${balance.toFixed(2)}; this sale tenders ${round2(input.amount).toFixed(2)}`,
      );
    }
    await db.storeCreditEntry.create({
      data: {
        tenantId: input.tenantId,
        customerId: input.customerId,
        saleId: input.saleId,
        // Negative: the ledger's sign IS the direction. A separate "type"
        // column would let a row say it redeems while its amount adds.
        amount: -round2(input.amount),
        reason: StoreCreditReason.SALE_REDEMPTION,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  }
}
