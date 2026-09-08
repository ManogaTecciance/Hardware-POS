import { Injectable } from '@nestjs/common';
import { Customer, CustomerType, Prisma } from '@hardware-pos/database';
import { isPhoneSearchable, phoneSearchKey } from '@hardware-pos/shared';

import { mirrorExternalRef } from '../quickbooks/external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditService } from '../credit/credit.service';

export interface CustomerListFilters {
  search?: string;
  customerType?: CustomerType;
  isActive?: boolean;
  /** Narrow to customers with at least one completed, unsettled sale. */
  hasOutstandingCredit?: boolean;
}

@Injectable()
export class CustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ids whose `phone` or `mobile` is the same number as `term`, however either
   * was formatted.
   *
   * Resolved as a separate query and fed back as an id set, because the
   * comparison cannot be expressed in Prisma's filter language: it needs the
   * stored value reduced to digits before matching. `regexp_replace` strips the
   * separators and `ltrim` the trunk zero — the same reduction as
   * `phoneSearchKey`, which the integration spec pins the two together on.
   *
   * Containment runs both ways so it does not matter which record was saved in
   * international format; see the module docblock in `shared/src/phone.ts`.
   */
  private async idsMatchingPhone(tenantId: string, term: string): Promise<string[]> {
    const key = phoneSearchKey(term);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH reduced AS (
        SELECT
          id,
          ltrim(regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'), '0') AS mobile_key,
          ltrim(regexp_replace(COALESCE(phone, ''),  '[^0-9]', '', 'g'), '0') AS phone_key
        FROM "Customer"
        WHERE "tenantId" = ${tenantId}
      )
      SELECT id FROM reduced
      WHERE (mobile_key <> '' AND (position(${key} in mobile_key) > 0 OR position(mobile_key in ${key}) > 0))
         OR (phone_key  <> '' AND (position(${key} in phone_key)  > 0 OR position(phone_key  in ${key}) > 0))
    `);
    return rows.map((r) => r.id);
  }

  async search(
    tenantId: string,
    filters: CustomerListFilters,
    skip: number,
    take: number,
  ): Promise<[Customer[], number]> {
    /*
     * Only when the term actually carries digits. `Nimal` must not run the
     * phone query at all, and a one-digit key would match most of the book.
     */
    const phoneIds =
      filters.search && isPhoneSearchable(filters.search)
        ? await this.idsMatchingPhone(tenantId, filters.search)
        : [];

    const where: Prisma.CustomerWhereInput = {
      tenantId,
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { company: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              // The raw clauses stay: they still match a term typed exactly as
              // stored, and they carry the `mode: 'insensitive'` behaviour the
              // customers list has always had for text.
              { phone: { contains: filters.search, mode: 'insensitive' } },
              { mobile: { contains: filters.search, mode: 'insensitive' } },
              // Omitted entirely when nothing matched — an empty `in` matches
              // no rows, but leaving it in reads as a filter that applied.
              ...(phoneIds.length > 0 ? [{ id: { in: phoneIds } }] : []),
            ],
          }
        : {}),
      ...(filters.customerType ? { customerType: filters.customerType } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      // A relational `some` rather than an aggregate: "owes anything at all" is a
      // question about the existence of an unsettled sale, not about a total.
      ...(filters.hasOutstandingCredit ? CreditService.HAS_OUTSTANDING : {}),
    };

    return this.prisma.$transaction([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.customer.count({ where }),
    ]);
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Customer | null> {
    return this.prisma.customer.findFirst({ where: { id, tenantId } });
  }

  create(tenantId: string, data: Prisma.CustomerUncheckedCreateInput): Promise<Customer> {
    return this.prisma.customer.create({ data: { ...data, tenantId } });
  }

  update(id: string, data: Prisma.CustomerUncheckedUpdateInput): Promise<Customer> {
    return this.prisma.customer.update({ where: { id }, data });
  }

  /**
   * Record a failed QuickBooks push so the customer does not read as synced and
   * the reason is visible in the Sync log rather than only in the API response.
   */
  async markQuickBooksSyncFailed(tenantId: string, id: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { syncStatus: 'FAILED' } });
      // D63 dual-write — the same mirror `queueQuickBooksSync` performs below.
      await mirrorExternalRef(tx, tenantId, 'CUSTOMER', id, { syncStatus: 'FAILED' });
      await tx.syncLog.create({
        data: {
          tenantId,
          entityType: 'CUSTOMER',
          entityId: id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          message: `QuickBooks customer push failed: ${reason}`,
        },
      });
    });
  }
}
