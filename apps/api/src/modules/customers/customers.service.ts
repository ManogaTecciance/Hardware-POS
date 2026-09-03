import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Customer, Prisma } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { QuickBooksCustomersService } from '../quickbooks/quickbooks-customers.service';
import { CustomersRepository } from './customers.repository';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly quickbooksCustomers: QuickBooksCustomersService,
  ) {}

  async list(tenantId: string, query: QueryCustomersDto): Promise<Paginated<Customer>> {
    const [items, total] = await this.customersRepository.search(
      tenantId,
      {
        search: query.search,
        customerType: query.customerType,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
      },
      query.skip,
      query.take,
    );
    return paginate(items, total, query.page, query.pageSize);
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
