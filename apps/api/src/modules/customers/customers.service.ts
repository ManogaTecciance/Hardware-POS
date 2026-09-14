import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Customer, Prisma } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { round2 } from '../../common/money';
import { paginate } from '../../common/pagination';
import {
  StoreCreditService,
  type StoreCreditEntryView,
} from '../store-credit/store-credit.service';
import { CreditService, type CustomerCredit } from '../credit/credit.service';
import { QuickBooksCustomersService } from '../quickbooks/quickbooks-customers.service';
import { CustomersRepository } from './customers.repository';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/** A customer row plus the credit figures the list column needs. */
export interface CustomerListItem extends Customer {
  /** Total unpaid balance across this customer's completed, unsettled sales. */
  outstandingCredit: number;
  /** `creditLimit - outstandingCredit`; null when no limit is configured. */
  availableCredit: number | null;
  /**
   * D175 — what the SHOP owes the customer, from returns refunded as store
   * credit.
   *
   * The opposite direction of money from the two fields above, and named so
   * that it cannot be mistaken for them: `availableCredit` is how much this
   * customer may still buy ON ACCOUNT. They were confused for each other in the
   * field — "when i return cloth and get store credit but customer available
   * store credit not updated in customer tab" — which is what prompted this.
   */
  storeCreditBalance: number;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly quickbooksCustomers: QuickBooksCustomersService,
    private readonly credit: CreditService,
    /** D175 — what the shop owes, as opposed to what it is owed. */
    private readonly storeCredit: StoreCreditService,
  ) {}

  async list(tenantId: string, query: QueryCustomersDto): Promise<Paginated<CustomerListItem>> {
    const [items, total] = await this.customersRepository.search(
      tenantId,
      {
        search: query.search,
        customerType: query.customerType,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
        hasOutstandingCredit: query.hasOutstandingCredit === 'true',
      },
      query.skip,
      query.take,
    );

    // One grouped query for the whole page rather than an aggregate per row.
    const ids = items.map((c) => c.id);
    // Both in one round trip each, not one aggregate per row: a customer list
    // that queries per row is a list that starts timing out at a few hundred.
    const [outstandingByCustomer, storeCreditByCustomer] = await Promise.all([
      this.credit.outstandingByCustomer(tenantId, ids),
      this.storeCredit.balancesFor(tenantId, ids),
    ]);
    const withCredit = items.map((customer) => {
      const outstanding = outstandingByCustomer.get(customer.id) ?? 0;
      const creditLimit = customer.creditLimit != null ? Number(customer.creditLimit) : null;
      return {
        ...customer,
        outstandingCredit: outstanding,
        // Null, not zero: "no limit set" and "no credit left" are different
        // answers and the table must not conflate them.
        availableCredit: creditLimit != null ? round2(creditLimit - outstanding) : null,
        // Zero, not null: every customer HAS a store-credit balance, and a
        // customer who has never been given any holds nothing. That is a real
        // answer, unlike "no credit limit configured" above.
        storeCreditBalance: storeCreditByCustomer.get(customer.id) ?? 0,
      };
    });

    return paginate(withCredit, total, query.page, query.pageSize);
  }

  /**
   * D175 — what the shop owes this customer, and where each part came from.
   *
   * Its OWN read, not a field on `CustomerCredit`. That shape answers "what may
   * this customer still buy on account"; this one answers "what do we owe
   * them". Folding the second into the first is how they were confused in the
   * first place, and an API that repeats the confusion teaches it to every
   * screen that reads it.
   *
   * `getById` first so an unknown or other-tenant id is a 404 rather than an
   * empty ledger, which would read as "this customer has no store credit".
   */
  async storeCreditFor(
    tenantId: string,
    id: string,
  ): Promise<{ balance: number; entries: StoreCreditEntryView[] }> {
    await this.getById(tenantId, id);
    const [balance, entries] = await Promise.all([
      this.storeCredit.balanceFor(tenantId, id),
      this.storeCredit.historyFor(tenantId, id),
    ]);
    return { balance, entries };
  }

  /** Live credit position for one customer; 404 when the customer is not theirs. */
  async creditFor(tenantId: string, id: string): Promise<CustomerCredit> {
    const credit = await this.credit.forCustomer(tenantId, id);
    if (!credit) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    return credit;
  }

  async getById(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.customersRepository.findByIdForTenant(tenantId, id);
    if (!customer) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    return customer;
  }

  /** Create a locally-managed customer (not yet in QuickBooks → NOT_SYNCED). */
  create(tenantId: string, dto: CreateCustomerDto): Promise<Customer> {
    const data: Prisma.CustomerUncheckedCreateInput = {
      tenantId,
      name: dto.name,
      company: dto.company ?? null,
      qbCustomerType: dto.qbCustomerType ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      mobile: dto.mobile ?? null,
      fax: dto.fax ?? null,
      website: dto.website ?? null,
      street: dto.street ?? null,
      city: dto.city ?? null,
      state: dto.state ?? null,
      zip: dto.zip ?? null,
      country: dto.country ?? null,
      openingBalance: dto.openingBalance ?? null,
      openingBalanceDate: dto.openingBalanceDate ? new Date(dto.openingBalanceDate) : null,
      resaleNumber: dto.resaleNumber ?? null,
      customerType: dto.customerType ?? 'RETAIL',
      creditAllowed: dto.creditAllowed ?? false,
      creditLimit: dto.creditLimit ?? null,
      isActive: dto.isActive ?? true,
      syncStatus: 'NOT_SYNCED',
    };
    return this.customersRepository.create(tenantId, data);
  }

  async update(tenantId: string, id: string, dto: UpdateCustomerDto): Promise<Customer> {
    await this.getById(tenantId, id);
    // Prisma treats `undefined` as "leave unchanged"; column names match the DTO.
    const data: Prisma.CustomerUncheckedUpdateInput = {
      name: dto.name,
      company: dto.company,
      qbCustomerType: dto.qbCustomerType,
      email: dto.email,
      phone: dto.phone,
      mobile: dto.mobile,
      fax: dto.fax,
      website: dto.website,
      street: dto.street,
      city: dto.city,
      state: dto.state,
      zip: dto.zip,
      country: dto.country,
      openingBalance: dto.openingBalance,
      openingBalanceDate:
        dto.openingBalanceDate === undefined
          ? undefined
          : dto.openingBalanceDate === null
            ? null
            : new Date(dto.openingBalanceDate),
      resaleNumber: dto.resaleNumber,
      customerType: dto.customerType,
      creditAllowed: dto.creditAllowed,
      creditLimit: dto.creditLimit,
      isActive: dto.isActive,
    };
    return this.customersRepository.update(id, data);
  }

  /**
   * Push a locally-created customer to QuickBooks now.
   *
   * Previously this only flagged the row PENDING and wrote a log line: no job
   * type existed for customers, so nothing ever drained it and the customer sat
   * PENDING forever. It now performs the push, adopting an existing QuickBooks
   * customer of the same name where there is one.
   */
  async syncToQuickBooks(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.getById(tenantId, id);
    if (customer.quickbooksCustomerId) {
      throw new BadRequestException('Customer is already linked to QuickBooks');
    }
    try {
      // The push writes its own SYNCED sync-log entry and sets the status, so no
      // PENDING row is queued first — the old stub left one behind permanently,
      // because nothing ever drained a customer queue that does not exist.
      await this.quickbooksCustomers.pushCustomer(tenantId, id);
    } catch (err) {
      await this.customersRepository.markQuickBooksSyncFailed(tenantId, id, (err as Error).message);
      throw new BadRequestException(
        `Could not sync customer to QuickBooks: ${(err as Error).message}`,
      );
    }
    return this.getById(tenantId, id);
  }
}
