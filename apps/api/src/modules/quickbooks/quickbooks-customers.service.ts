import { Injectable, Logger } from '@nestjs/common';
import { Customer } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';
import {
  createCustomer,
  queryCustomerByName,
  type QboCustomerInput,
  type QboRef,
  type RequestParams,
} from './quickbooks.api';

/**
 * Resolving a POS customer to the QuickBooks customer a document must reference.
 *
 * Shared by the sales and returns syncs, which previously each carried their own
 * copy of this and both looked in the wrong place: they read the
 * `QuickBooksMapping` table, which nothing in the codebase has ever written, so
 * the lookup returned null for every customer. An Invoice without a CustomerRef
 * is rejected outright (QBO error 6560), and a Sales Receipt silently posted with
 * no customer attached at all.
 *
 * The real link is `Customer.quickbooksCustomerId` — the same field the inbound
 * pull populates — mirroring how products resolve through `Product.quickbooksItemId`.
 *
 * A customer created in the POS has no link yet, so this also establishes one,
 * preferring to adopt an existing QuickBooks customer of the same name over
 * creating a second record for the same person.
 */
@Injectable()
export class QuickBooksCustomersService {
  private readonly logger = new Logger(QuickBooksCustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  /**
   * Push one local customer to QuickBooks on demand — the customer page's
   * "Sync to QuickBooks" action.
   *
   * The sync paths resolve lazily, when a sale first needs the reference; this is
   * the explicit version for a customer created ahead of any sale. Both funnel
   * into the same link-or-create, so neither can produce a duplicate the other
   * would then have to reconcile.
   */
  async pushCustomer(tenantId: string, customerId: string): Promise<string> {
    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      throw new Error('QuickBooks is not connected');
    }
    const accessToken = await this.oauth.getValidAccessToken(tenantId);
    const { apiBase } = this.config.resolve();
    const ref = await this.resolveCustomerRef(tenantId, customerId, {
      apiBase,
      realmId: connection.realmId,
      accessToken,
    });
    if (!ref) throw new Error(`Customer ${customerId} not found`);
    return ref.value;
  }

  /**
   * The `CustomerRef` for a document, linking or creating the QuickBooks customer
   * if this is the first time the POS has needed one.
   *
   * Returns null only for a sale with no customer at all (a walk-in) — that is a
   * legitimate Sales Receipt, and callers that genuinely require a customer
   * (Invoice, Credit Memo, Payment) raise their own error on null.
   */
  async resolveCustomerRef(
    tenantId: string,
    customerId: string | null,
    params: RequestParams,
  ): Promise<QboRef | null> {
    if (!customerId) return null;

    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) return null;
    if (customer.quickbooksCustomerId) return { value: customer.quickbooksCustomerId };

    const displayName = customer.name.trim();
    if (!displayName) {
      // QuickBooks requires a DisplayName, so there is nothing to create from.
      // Better a clear sync failure than a customer named " " in the books.
      throw new Error(
        `Customer ${customerId} has no name — cannot create it in QuickBooks. Give it a name and retry.`,
      );
    }

    return { value: await this.linkOrCreate(tenantId, customer, displayName, params) };
  }

  /**
   * Adopt the QuickBooks customer of the same name if there is one, otherwise
   * create it. Either way the id is persisted, so a retry of the same sync — the
   * queue retries on failure — reuses it rather than making a second customer.
   */
  private async linkOrCreate(
    tenantId: string,
    customer: Customer,
    displayName: string,
    params: RequestParams,
  ): Promise<string> {
    const existing = await queryCustomerByName(params, displayName);
    if (existing) {
      this.logger.log(`Linked "${displayName}" to existing QuickBooks customer ${existing.Id}`);
      const id = await this.persist(tenantId, customer.id, existing.Id, displayName);
      await this.record(
        tenantId,
        customer.id,
        `Linked "${displayName}" to QuickBooks customer ${id}`,
      );
      return id;
    }

    try {
      const created = await createCustomer(params, this.toCustomerInput(displayName, customer));
      this.logger.log(`Created QuickBooks customer ${created.Id} for "${displayName}"`);
      const id = await this.persist(tenantId, customer.id, created.Id, displayName);
      await this.record(
        tenantId,
        customer.id,
        `Created QuickBooks customer ${id} for "${displayName}"`,
      );
      return id;
    } catch (err) {
      if (!this.isDuplicateName(err)) throw err;
      // DisplayName is unique per QuickBooks company, across customers, vendors
      // and employees alike. Re-querying resolves the case we can recover from —
      // another worker created the same customer between our check and our write.
      const now = await queryCustomerByName(params, displayName);
      if (now) {
        this.logger.log(`Adopted QuickBooks customer ${now.Id} for "${displayName}" after a clash`);
        const id = await this.persist(tenantId, customer.id, now.Id, displayName);
        await this.record(
          tenantId,
          customer.id,
          `Adopted QuickBooks customer ${id} for "${displayName}"`,
        );
        return id;
      }
      // Nothing came back, so the name is taken by something that is not an
      // active customer — most often a vendor of the same name, which is routine
      // for a hardware shop that both buys from and sells to a company.
      throw new Error(
        `QuickBooks already has a vendor or inactive record named "${displayName}", ` +
          `so the customer cannot be created. Rename the customer, or link it in QuickBooks.`,
      );
    }
  }

  /**
   * Leave a trail in the sync log. These writes land in the client's accounting
   * system, so "the POS created this customer" has to be answerable afterwards
   * from the Sync log rather than only from server logs.
   */
  private async record(tenantId: string, customerId: string, message: string): Promise<void> {
    try {
      await this.prisma.syncLog.create({
        data: {
          tenantId,
          entityType: 'CUSTOMER',
          entityId: customerId,
          direction: 'OUTBOUND',
          status: 'SYNCED',
          message,
        },
      });
    } catch (err) {
      // An audit row must never be the thing that fails a sale.
      this.logger.warn(`Could not write customer sync log: ${(err as Error).message}`);
    }
  }

  /** QBO error 6240 — "Duplicate Name Exists Error". */
  private isDuplicateName(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /"code"\s*:\s*"?6240/.test(message) || /duplicate name/i.test(message);
  }

  /**
   * Claim the link, write-once.
   *
   * A compare-and-set on `quickbooksCustomerId: null` rather than a plain update,
   * because two sales for the same new customer can sync concurrently: whoever
   * writes second must adopt the first one's id instead of overwriting it. A
   * P2002 here means something else entirely — a DIFFERENT local customer already
   * holds this QuickBooks id, which the tenant-scoped unique index forbids and
   * which no retry can fix.
   */
  private async persist(
    tenantId: string,
    customerId: string,
    quickbooksId: string,
    displayName: string,
  ): Promise<string> {
    try {
      const { count } = await this.prisma.customer.updateMany({
        where: { id: customerId, tenantId, quickbooksCustomerId: null },
        data: {
          quickbooksCustomerId: quickbooksId,
          syncStatus: 'SYNCED',
          lastSyncedAt: new Date(),
        },
      });
      if (count > 0) return quickbooksId;
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      throw new Error(
        `QuickBooks customer ${quickbooksId} ("${displayName}") is already linked to a different ` +
          `customer in this shop. Merge the duplicates before syncing.`,
      );
    }

    // count === 0: a concurrent run linked it first. Its id is the winner.
    const fresh = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { quickbooksCustomerId: true },
    });
    return fresh?.quickbooksCustomerId ?? quickbooksId;
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }

  /**
   * The QuickBooks create body, inverting the field mapping the inbound pull uses
   * (`QuickBooksPartiesSyncService.customerCreateData`) so a customer round-trips
   * through both directions unchanged.
   *
   * `openingBalance` is deliberately not sent: QuickBooks owns the live A/R
   * balance, and supplying one would make it post an opening-balance journal
   * entry on top of the invoices the POS is already pushing.
   */
  private toCustomerInput(displayName: string, c: Customer): QboCustomerInput {
    const str = (v: string | null): string | undefined => v?.trim() || undefined;
    const body: QboCustomerInput = { DisplayName: displayName };

    const company = str(c.company);
    if (company) body.CompanyName = company;
    const email = str(c.email);
    if (email) body.PrimaryEmailAddr = { Address: email };
    const phone = str(c.phone);
    if (phone) body.PrimaryPhone = { FreeFormNumber: phone };
    const mobile = str(c.mobile);
    if (mobile) body.Mobile = { FreeFormNumber: mobile };
    const fax = str(c.fax);
    if (fax) body.Fax = { FreeFormNumber: fax };
    const website = str(c.website);
    if (website) body.WebAddr = { URI: website };
    const resale = str(c.resaleNumber);
    if (resale) body.ResaleNum = resale;

    // Only send an address when there is something in it; an all-empty BillAddr
    // makes QuickBooks render a blank address block on the invoice.
    const line1 = str(c.street);
    const city = str(c.city);
    const state = str(c.state);
    const zip = str(c.zip);
    const country = str(c.country);
    if (line1 || city || state || zip || country) {
      body.BillAddr = {
        ...(line1 ? { Line1: line1 } : {}),
        ...(city ? { City: city } : {}),
        ...(state ? { CountrySubDivisionCode: state } : {}),
        ...(zip ? { PostalCode: zip } : {}),
        ...(country ? { Country: country } : {}),
      };
    }

    return body;
  }
}
