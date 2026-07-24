import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Supplier } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { QuickBooksVendorsService } from '../quickbooks/quickbooks-vendors.service';
import type { QuerySuppliersDto } from './dto/query-suppliers.dto';
import type { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier-input.dto';
import { toSupplierDto } from './suppliers.mapper';
import { SuppliersRepository } from './suppliers.repository';
import type { SupplierDto } from './suppliers.types';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly repo: SuppliersRepository,
    private readonly qbVendors: QuickBooksVendorsService,
  ) {}

  private async getOr404(tenantId: string, id: string): Promise<Supplier> {
    const supplier = await this.repo.findByIdForTenant(tenantId, id);
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  async list(tenantId: string, query: QuerySuppliersDto): Promise<Paginated<SupplierDto>> {
    const [rows, total] = await this.repo.search(
      tenantId,
      {
        search: query.search,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
        qbStatus: query.qbStatus,
      },
      query.sort,
      query.skip,
      query.take,
    );
    return { items: rows.map(toSupplierDto), total, page: query.page, pageSize: query.pageSize };
  }

  async getById(tenantId: string, id: string): Promise<SupplierDto> {
    return toSupplierDto(await this.getOr404(tenantId, id));
  }

  /** The DB unique is case-sensitive; vendor names must be unique like QuickBooks treats them. */
  private async assertNameFree(tenantId: string, name: string, exceptId?: string): Promise<void> {
    const existing = await this.repo.findByName(tenantId, name.trim());
    if (existing && existing.id !== exceptId) {
      throw new ConflictException('A vendor with this name already exists');
    }
  }

  async create(tenantId: string, dto: CreateSupplierDto): Promise<SupplierDto> {
    await this.assertNameFree(tenantId, dto.name);
    try {
      const supplier = await this.repo.create(tenantId, this.toCreateData(dto));
      return toSupplierDto(supplier);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A vendor with this name already exists');
      }
      throw err;
    }
  }

  async update(tenantId: string, id: string, dto: UpdateSupplierDto): Promise<SupplierDto> {
    await this.getOr404(tenantId, id);
    if (dto.name) await this.assertNameFree(tenantId, dto.name, id);
    try {
      const supplier = await this.repo.update(id, {
        name: dto.name ?? undefined,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        mobile: dto.mobile,
        fax: dto.fax,
        website: dto.website,
        street: dto.street,
        city: dto.city,
        province: dto.province,
        postalCode: dto.postalCode,
        country: dto.country,
        openingBalance: dto.openingBalance,
        openingBalanceDate:
          dto.openingBalanceDate === undefined
            ? undefined
            : dto.openingBalanceDate === null
              ? null
              : new Date(dto.openingBalanceDate),
        taxId: dto.taxId,
        isActive: dto.isActive ?? undefined,
      });
      return toSupplierDto(supplier);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A vendor with this name already exists');
      }
      throw err;
    }
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const supplier = await this.getOr404(tenantId, id);
    if (supplier.quickbooksVendorId) {
      throw new BadRequestException(
        'This vendor is mapped to QuickBooks — unmap it first or mark it inactive instead.',
      );
    }
    await this.repo.delete(id);
  }

  // ── QuickBooks vendor mapping ──────────────────────────────────────────────

  async mapQbVendor(tenantId: string, id: string, vendorId: string): Promise<SupplierDto> {
    await this.getOr404(tenantId, id);
    const vendor = await this.qbVendors.findVendor(tenantId, vendorId);
    if (!vendor) throw new BadRequestException('QuickBooks vendor not found');
    try {
      const supplier = await this.repo.update(id, {
        quickbooksVendorId: vendor.id,
        quickbooksVendorName: vendor.name,
        qbStatus: 'CONNECTED',
        qbLastSyncedAt: new Date(),
      });
      return toSupplierDto(supplier);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('This QuickBooks vendor is already mapped to another supplier');
      }
      throw err;
    }
  }

  async unmapQbVendor(tenantId: string, id: string): Promise<SupplierDto> {
    await this.getOr404(tenantId, id);
    const supplier = await this.repo.update(id, {
      quickbooksVendorId: null,
      quickbooksVendorName: null,
      qbStatus: 'NOT_CONNECTED',
      qbLastSyncedAt: null,
    });
    return toSupplierDto(supplier);
  }

  // ── Shared with the import service ─────────────────────────────────────────

  toCreateData(dto: CreateSupplierDto): Omit<Prisma.SupplierUncheckedCreateInput, 'tenantId'> {
    return {
      name: dto.name.trim(),
      company: dto.company ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      mobile: dto.mobile ?? null,
      fax: dto.fax ?? null,
      website: dto.website ?? null,
      street: dto.street ?? null,
      city: dto.city ?? null,
      province: dto.province ?? null,
      postalCode: dto.postalCode ?? null,
      country: dto.country ?? null,
      openingBalance: dto.openingBalance ?? null,
      openingBalanceDate: dto.openingBalanceDate ? new Date(dto.openingBalanceDate) : null,
      taxId: dto.taxId ?? null,
      isActive: dto.isActive ?? true,
    };
  }
}
