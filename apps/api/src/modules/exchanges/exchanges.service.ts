import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentMethod } from '@hardware-pos/database';

import { AuthenticatedUser } from '../auth/auth.types';
import { ReturnsService } from '../returns/returns.service';
import { SalesService } from '../sales/sales.service';
import { CompleteExchangeDto } from './dto/complete-exchange.dto';
import { ExchangesRepository, type ExchangeWithLegs } from './exchanges.repository';

/** What the caller gets back, with the money already reconciled for display. */
export interface ExchangeResult {
  id: string;
  exchangeNumber: string;
  /** Value of the goods coming back, refunded on the returning leg. */
  returnedValue: number;
  /** Value of the goods going out. `null` while the replacement is unfinished. */
  replacementValue: number | null;
  /** `replacement − returned`. Positive = customer owes, negative = owed back. */
  netDifference: number | null;
  returnId: string;
  returnNumber: string;
  replacementSaleId: string | null;
  replacementSaleNumber: string | null;
  /** False while the replacement leg has not completed — see D107. */
  complete: boolean;
}

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private readonly repo: ExchangesRepository,
    private readonly returns: ReturnsService,
    private readonly sales: SalesService,
  ) {}

  /**
   * D107 — return one variant, issue another, settle the difference.
   *
   * This method **orchestrates and records**. It computes no prices, moves no
   * stock, touches no tax and writes no payment of its own. Promotion allocation
   * (D102), tax snapshots (`3.11`) and variant-grain stock (`1a.20`, `1c.6`) are
   * already correct in the two paths it calls, and a second copy of any of them
   * is where they drift.
   *
   * ## Order, and why it is not a transaction
   *
   * `ReturnsRepository` and `SalesRepository` each own their `$transaction` and
   * neither accepts an external one. Refactoring them is the largest blast
   * radius on this branch, so the exchange is composed instead:
   *
   *   1. Return  → refunded by `refundMethod` (default CASH), value R
   *   2. Draft   → the server prices the replacement, value P (a draft moves no
   *                stock, so this is free to do after the return)
   *   3. Sale    → paid in full by the caller's own tenders
   *
   * ## Settlement is GROSS, not netted (D107a)
   *
   * D107 originally netted the two legs through `STORE_CREDIT`. That cannot run
   * at a counter: `ReturnsService` refuses a store-credit refund unless the sale
   * has a saved, non-walk-in customer — correctly, since store credit is a
   * liability held against an account — and a clothing shop swapping a size is
   * almost always a walk-in.
   *
   * So the money moves twice and nets at the drawer: the customer is handed the
   * value of what they brought back, and pays for what they take away. For an
   * even swap those are the same figure. This needed no change to any existing
   * money path, which is why the PO chose it.
   *
   * If step 3 fails the exchange row survives with `replacementSaleId = null`
   * and the customer has already been refunded for the goods they handed back.
   * Nothing is lost, nothing is double-counted, and the operator can ring the
   * replacement up as an ordinary sale. That is the recoverable state D107
   * chose, not an accident.
   */
  async complete(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CompleteExchangeDto,
    headerIdempotencyKey: string | null,
  ): Promise<ExchangeResult> {
    const key = dto.idempotencyKey ?? headerIdempotencyKey;

    // A replay must never refund twice. Checked before the return leg runs,
    // because that leg is the one that moves the customer's money.
    if (key) {
      const existing = await this.repo.findByIdempotencyKey(tenantId, key);
      if (existing) return this.toResult(existing);
    }

    // ── 1. The returning leg ────────────────────────────────────────────────
    //
    // Straight through `ReturnsService`, with ITS rules intact: allowed refund
    // methods, the cash-refund cap, approval triggers, promotion allocation and
    // tax snapshots. Nothing here overrides any of them.
    const returned = await this.returns.complete(
      tenantId,
      actor,
      {
        originalSaleId: dto.originalSaleId,
        items: dto.returnItems,
        refundMethod: dto.refundMethod ?? PaymentMethod.CASH,
        approvalToken: dto.approvalToken,
        notes: dto.notes,
        // Derived, not shared: the return has its own idempotency table and a
        // collision between the two would make a replayed exchange find a
        // return that is not its own.
        idempotencyKey: key ? `${key}:return` : undefined,
      },
      null,
    );

    const returnedValue = Number(returned.refundTotal);

    // ── 2. Record the exchange with only the leg that exists ────────────────
    const exchangeNumber = await this.repo.nextExchangeNumber(tenantId);
    let exchange = await this.repo.create({
      tenantId,
      branchId: dto.branchId,
      exchangeNumber,
      originalSaleId: dto.originalSaleId,
      returnId: returned.id,
      createdByUserId: actor.id,
      idempotencyKey: key ?? null,
    });

    // ── 3. The replacement leg ──────────────────────────────────────────────
    try {
      // Price it server-side. The client knows what it displayed, but a client
      // amount is never what the money is settled on — the same rule the return
      // path states in as many words.
      const draft = await this.sales.createDraft(tenantId, actor, {
        branchId: dto.branchId,
        registerId: dto.registerId,
        customerId: dto.customerId,
        items: dto.replacementItems,
      });
      const replacementValue = Number(draft.total);

      // The caller's tenders, unchanged. `SalesService` validates them against
      // the total it just computed, exactly as it does for any other sale —
      // this service asserts nothing about the money.
      const payments = dto.payments;

      const sale = await this.sales.complete(tenantId, actor, {
        saleId: draft.id,
        payments,
      });

      exchange = await this.repo.attachReplacementSale(exchange.id, sale.id);
    } catch (err) {
      // Deliberately re-thrown, NOT swallowed. The exchange row stays with a
      // null replacement, the customer has already been refunded for the goods
      // they handed back, and the operator sees why the replacement failed.
      this.logger.warn(
        `Exchange ${exchangeNumber}: the returning leg completed but the replacement did not — ` +
          `the customer has been refunded ${returnedValue} and can be sold the replacement as an ` +
          `ordinary sale. Cause: ${(err as Error).message}`,
      );
      throw err;
    }

    return this.toResult(exchange);
  }

  async getById(tenantId: string, id: string): Promise<ExchangeResult> {
    const row = await this.repo.findById(tenantId, id);
    if (!row) throw new NotFoundException(`Exchange ${id} not found`);
    return this.toResult(row);
  }

  async list(tenantId: string, take = 50): Promise<ExchangeResult[]> {
    if (take < 1 || take > 200) {
      throw new BadRequestException('take must be between 1 and 200');
    }
    const rows = await this.repo.listForTenant(tenantId, take);
    return rows.map((r) => this.toResult(r));
  }

  private toResult(row: ExchangeWithLegs): ExchangeResult {
    const returnedValue = Number(row.return.refundTotal);
    const replacementValue = row.replacementSale ? Number(row.replacementSale.total) : null;
    return {
      id: row.id,
      exchangeNumber: row.exchangeNumber,
      returnedValue,
      replacementValue,
      netDifference:
        replacementValue === null
          ? null
          : Math.round((replacementValue - returnedValue) * 100) / 100,
      returnId: row.returnId,
      returnNumber: row.return.returnNumber,
      replacementSaleId: row.replacementSaleId,
      replacementSaleNumber: row.replacementSale?.saleNumber ?? null,
      // The nullable column IS the status (D107) — there is no second field
      // encoding the same fact.
      complete: row.replacementSaleId !== null,
    };
  }
}
