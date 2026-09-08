import { Injectable, Logger } from '@nestjs/common';
import type { PaymentMethod } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  queryAccounts,
  queryPaymentMethods,
  type QboAccount,
  type QboPaymentMethod,
  type QboRef,
  type RequestParams,
} from './quickbooks.api';

/** How long a company's account / payment-method lists stay cached. */
const LOOKUP_TTL_MS = 15 * 60_000;

interface CachedLookups {
  accounts: QboAccount[];
  paymentMethods: QboPaymentMethod[];
  fetchedAt: number;
}

/** The refund tender resolved onto the fields a Refund Receipt needs. */
export interface ResolvedRefundTender {
  /** The account the money is paid back from. QuickBooks requires this. */
  depositToAccountRef: QboRef;
  /** The tender itself. Optional in QuickBooks, so null when nothing matches. */
  paymentMethodRef: QboRef | null;
  /** True when nothing was configured and the account was inferred. */
  inferred: boolean;
}

/**
 * Account preference per POS tender, most-specific first, as QuickBooks
 * `AccountSubType` values (or a bare `AccountType` where the subtype is too
 * narrow to rely on).
 *
 * A refund's `DepositToAccountRef` names the account the money LEAVES, so the
 * mapping follows the till: cash goes back out of the drawer, a card or QR
 * refund reverses through the same undeposited-funds holding account a card sale
 * lands in, and a bank transfer or cheque leaves the current account.
 */
const ACCOUNT_PREFERENCE: Record<string, string[]> = {
  CASH: ['CashOnHand', 'Checking', 'Bank', 'UndepositedFunds'],
  CARD: ['UndepositedFunds', 'Checking', 'Bank', 'CashOnHand'],
  QR_PAYMENT: ['UndepositedFunds', 'Checking', 'Bank', 'CashOnHand'],
  BANK_TRANSFER: ['Checking', 'Savings', 'Bank', 'UndepositedFunds'],
  CHECK: ['Checking', 'Savings', 'Bank', 'UndepositedFunds'],
  OTHER: ['UndepositedFunds', 'Checking', 'Bank', 'CashOnHand'],
};

/** Fallback order when the POS return carries no tender at all. */
const DEFAULT_PREFERENCE = ACCOUNT_PREFERENCE.OTHER;

/** Name patterns that identify a QuickBooks PaymentMethod for a POS tender. */
const PAYMENT_METHOD_PATTERN: Record<string, RegExp> = {
  CASH: /^cash\b/i,
  CARD: /credit\s*card|debit\s*card|\bvisa\b|master\s*card|\bamex\b|american\s+express/i,
  BANK_TRANSFER: /bank\s*transfer|\bach\b|\bwire\b|direct\s*deposit|\beft\b/i,
  QR_PAYMENT: /\bqr\b|mobile\s*(pay|wallet)|digital\s*wallet|\bupi\b/i,
  CHECK: /^che(ck|que)\b/i,
};

/**
 * Resolves the two QuickBooks fields a Refund Receipt needs beyond its lines:
 * the account the refund is paid from, and the tender it was paid in.
 *
 * This exists because omitting `DepositToAccountRef` fails the create outright —
 * QuickBooks answers with validation fault 2020, "Required parameter
 * DepositToAccountRef is missing in the request". The returns sync previously
 * only sent the field when a tenant had configured an account id, and nothing in
 * the product ever set one, so every Refund Receipt failed. (A Sales Receipt
 * tolerates the omission and defaults to Undeposited Funds, which is where the
 * mistaken assumption that a Refund Receipt would too came from.)
 *
 * Resolution order, most explicit first:
 *   1. `returns.quickbooksRefundDepositAccountRefs[TENDER]` — per-tender override
 *   2. `returns.quickbooksRefundReceiptDepositAccountRef` — the flat setting
 *   3. inferred from the company's chart of accounts, per {@link ACCOUNT_PREFERENCE}
 *
 * Step 3 writes into a client's real books with an account nobody chose, so it is
 * logged and recorded in the sync log rather than done silently — the same reason
 * {@link QuickBooksCustomersService} records the customers it creates. Configuring
 * an account stops the inference and the log entries with it.
 *
 * Credit Memos take neither field; only the Refund Receipt path calls this.
 */
@Injectable()
export class QuickBooksRefundTenderService {
  private readonly logger = new Logger(QuickBooksRefundTenderService.name);
  private readonly cache = new Map<string, CachedLookups>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async resolve(
    tenantId: string,
    method: PaymentMethod | null,
    params: RequestParams,
    context: { returnId: string; returnNumber: string },
  ): Promise<ResolvedRefundTender> {
    const configured = this.configuredAccountId(tenantId, method);
    const lookups = await this.lookups(tenantId, params);

    const depositToAccountRef = configured
      ? this.verifyConfigured(configured, lookups.accounts, context.returnNumber)
      : this.inferAccount(method, lookups.accounts);

    const paymentMethodRef = this.matchPaymentMethod(method, lookups.paymentMethods);

    if (!configured) {
      await this.recordInference(tenantId, method, depositToAccountRef, context);
    }
    return { depositToAccountRef, paymentMethodRef, inferred: !configured };
  }

  /** Drop a tenant's cached lists — used after a QuickBooks reconnect. */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  // ── resolution ─────────────────────────────────────────────────────────────

  /** The configured account id for this tender: per-tender override, then flat. */
  private configuredAccountId(tenantId: string, method: PaymentMethod | null): string | null {
    const returns = this.settings.getSettings(tenantId).returns;
    const perTender = method ? returns.quickbooksRefundDepositAccountRefs?.[method] : null;
    return perTender?.trim() || returns.quickbooksRefundReceiptDepositAccountRef?.trim() || null;
  }

  /**
   * Trust a configured id, but name the account when we can see it.
   *
   * A miss is only warned about, never fatal: the account query is capped at 1000
   * rows, so a large company's chart can legitimately not contain an id that is
   * nonetheless valid. Refusing the sync over our own truncated view would be
   * worse than letting QuickBooks be the judge.
   */
  private verifyConfigured(id: string, accounts: QboAccount[], returnNumber: string): QboRef {
    const match = accounts.find((a) => a.Id === id);
    if (match) return { value: match.Id, name: match.Name };
    this.logger.warn(
      `Configured refund deposit account ${id} was not found in the QuickBooks chart of accounts ` +
        `(return ${returnNumber}); sending it anyway`,
    );
    return { value: id };
  }

  /**
   * Pick the closest account the company actually has, walking the tender's
   * preference list. Subtypes are tried first, then the bare `AccountType`, so a
   * company whose bank account carries an unusual subtype is still matched.
   */
  private inferAccount(method: PaymentMethod | null, accounts: QboAccount[]): QboRef {
    const preference = (method && ACCOUNT_PREFERENCE[method]) || DEFAULT_PREFERENCE;
    for (const key of preference) {
      const match =
        accounts.find((a) => a.AccountSubType === key) ??
        accounts.find((a) => a.AccountType === key);
      if (match) return { value: match.Id, name: match.Name };
    }

    // Nothing bank-like at all. Bail with the fix rather than let QuickBooks
    // answer with the bare 2020 this whole path exists to prevent.
    throw new Error(
      `QuickBooks has no Bank, Cash on Hand or Undeposited Funds account to refund ` +
        `${method ?? 'this return'} from. Add one in QuickBooks, or set the refund deposit ` +
        `account in Settings → Returns.`,
    );
  }

  /**
   * The QuickBooks PaymentMethod matching the POS tender, or null.
   *
   * Always optional: a shop that never set up payment methods, or named them in
   * Sinhala, still gets its refund posted — just without the tender recorded.
   * Store credit is excluded because it never reaches a Refund Receipt.
   */
  private matchPaymentMethod(
    method: PaymentMethod | null,
    methods: QboPaymentMethod[],
  ): QboRef | null {
    if (!method || method === 'STORE_CREDIT' || methods.length === 0) return null;

    const pattern = PAYMENT_METHOD_PATTERN[method];
    const byName = pattern ? methods.find((m) => pattern.test(m.Name)) : undefined;
    if (byName) return { value: byName.Id, name: byName.Name };

    // A card refund is worth recording even under a differently-named card
    // method; QuickBooks' own CREDIT_CARD flag is the reliable signal there.
    if (method === 'CARD') {
      const byType = methods.find((m) => m.Type === 'CREDIT_CARD');
      if (byType) return { value: byType.Id, name: byType.Name };
    }
    return null;
  }

  // ── lookups ────────────────────────────────────────────────────────────────

  /**
   * The company's accounts and payment methods, cached per tenant.
   *
   * The raw lists are cached rather than a resolved account, so a settings change
   * takes effect on the next refund instead of waiting out the TTL.
   */
  private async lookups(tenantId: string, params: RequestParams): Promise<CachedLookups> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < LOOKUP_TTL_MS) return cached;

    const [accounts, paymentMethods] = await Promise.all([
      queryAccounts(params),
      // Never let a missing payment method sink the refund: the tender is
      // optional, the account is not.
      queryPaymentMethods(params).catch((err: unknown) => {
        this.logger.warn(
          `Could not list QuickBooks payment methods: ${(err as Error).message}; ` +
            `refunds will post without a PaymentMethodRef`,
        );
        return [] as QboPaymentMethod[];
      }),
    ]);

    const fresh: CachedLookups = { accounts, paymentMethods, fetchedAt: Date.now() };
    this.cache.set(tenantId, fresh);
    return fresh;
  }

  /**
   * Leave a trail when we chose the account ourselves. This posts money out of a
   * real account in the client's books, so "why did this refund come out of
   * Undeposited Funds?" has to be answerable from the Sync log afterwards.
   */
  private async recordInference(
    tenantId: string,
    method: PaymentMethod | null,
    account: QboRef,
    context: { returnId: string; returnNumber: string },
  ): Promise<void> {
    const label = account.name ? `${account.name} (${account.value})` : account.value;
    this.logger.warn(
      `No refund deposit account configured; return ${context.returnNumber} ` +
        `(${method ?? 'no tender'}) will refund from ${label}. ` +
        `Set Settings → Returns → refund deposit account to choose it deliberately.`,
    );
    try {
      await this.prisma.syncLog.create({
        data: {
          tenantId,
          entityType: 'RETURN',
          entityId: context.returnId,
          direction: 'OUTBOUND',
          status: 'PENDING',
          message:
            `No refund deposit account is configured — inferred ${label} ` +
            `for the ${method ?? 'untendered'} refund on ${context.returnNumber}`,
        },
      });
    } catch (err) {
      // An audit row must never be the thing that fails a refund.
      this.logger.warn(`Could not write refund account sync log: ${(err as Error).message}`);
    }
  }
}
