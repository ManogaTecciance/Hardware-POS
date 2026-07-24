import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  queryAllCustomers,
  queryAllVendors,
  type QboAddress,
  type QboCustomer,
  type QboVendor,
} from './quickbooks.api';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';

export interface CustomerSyncSummary {
  /** QuickBooks customers pulled in as new local records. */
  created: number;
  /** Local customers newly linked to a QuickBooks customer by exact name. */
  linked: number;
  /** Already-linked customers whose sync state was refreshed. */
  refreshed: number;
  /** QuickBooks customers seen. */
  total: number;
}

/** Mapping counts for the QuickBooks overview cards (no QBO round-trip). */
export interface PartySyncStatus {
  customers: { linked: number; total: number; lastSyncedAt: string | null };
  vendors: { linked: number; total: number; attention: number; lastSyncedAt: string | null };
}

export interface VendorSyncSummary {
  /** QuickBooks vendors pulled in as new local suppliers. */
  created: number;
  /** Suppliers newly linked to a QuickBooks vendor by exact name. */
  linked: number;
  /** Mapped suppliers whose vendor name / sync state was refreshed. */
  refreshed: number;
  /** Mapped suppliers whose QuickBooks vendor is missing or inactive. */
  flagged: number;
  /** QuickBooks vendors seen. */
  total: number;
}

function addressFields(a: QboAddress | undefined): {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
} {
  return {
    street: [a?.Line1, a?.Line2].filter(Boolean).join(', ') || null,
    city: a?.City ?? null,
    state: a?.CountrySubDivisionCode ?? null,
    zip: a?.PostalCode ?? null,
    country: a?.Country ?? null,
  };
}

/**
 * Reconciles local customers and suppliers against the QuickBooks company:
 * refreshes the linkage of already-mapped records and auto-links unmapped ones
 * whose display name matches exactly. Field contents are not overwritten —
 * imports and manual edits own those; this pass only maintains the mapping.
 */
@Injectable()
export class QuickBooksPartiesSyncService {
  private readonly logger = new Logger(QuickBooksPartiesSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  private async params(tenantId: string): Promise<{
    apiBase: string;
    realmId: string;
    accessToken: string;
  }> {
    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) {
      throw new NotFoundException('QuickBooks is not connected');
    }
    const accessToken = await this.oauth.getValidAccessToken(tenantId);
    const { apiBase } = this.config.resolve();
    return { apiBase, realmId: connection.realmId, accessToken };
  }

  /** Local mapping counts for the overview cards — no QuickBooks call involved. */
  async partyStatus(tenantId: string): Promise<PartySyncStatus> {
    const [customerTotal, customerLinked, customerLast, vendorTotal, vendorLinked, vendorAttention, vendorLast] =
      await this.prisma.$transaction([
        this.prisma.customer.count({ where: { tenantId } }),
        this.prisma.customer.count({ where: { tenantId, quickbooksCustomerId: { not: null } } }),
        this.prisma.customer.aggregate({ where: { tenantId }, _max: { lastSyncedAt: true } }),
        this.prisma.supplier.count({ where: { tenantId } }),
        this.prisma.supplier.count({ where: { tenantId, quickbooksVendorId: { not: null } } }),
        this.prisma.supplier.count({ where: { tenantId, qbStatus: 'ATTENTION' } }),
        this.prisma.supplier.aggregate({ where: { tenantId }, _max: { qbLastSyncedAt: true } }),
      ]);
    return {
      customers: {
        linked: customerLinked,
        total: customerTotal,
        lastSyncedAt: customerLast._max.lastSyncedAt?.toISOString() ?? null,
      },
      vendors: {
        linked: vendorLinked,
        total: vendorTotal,
        attention: vendorAttention,
        lastSyncedAt: vendorLast._max.qbLastSyncedAt?.toISOString() ?? null,
      },
    };
  }

  async syncCustomers(tenantId: string): Promise<CustomerSyncSummary> {
    const params = await this.params(tenantId);
    const qboCustomers = await queryAllCustomers(params);
    const active = qboCustomers.filter((c) => c.Active !== false);
    const byId = new Map(active.map((c) => [c.Id, c]));
    const byName = new Map(active.map((c) => [c.DisplayName.trim().toLowerCase(), c]));

    const locals = await this.prisma.customer.findMany({
      where: { tenantId },
      select: { id: true, name: true, quickbooksCustomerId: true },
    });

    const now = new Date();
    const usedIds = new Set(locals.map((l) => l.quickbooksCustomerId).filter(Boolean) as string[]);
    let created = 0;
    let linked = 0;
    let refreshed = 0;

    for (const local of locals) {
      if (local.quickbooksCustomerId) {
        if (byId.has(local.quickbooksCustomerId)) {
          await this.prisma.customer.update({
            where: { id: local.id },
            data: { syncStatus: 'SYNCED', lastSyncedAt: now },
          });
          refreshed++;
        }
        continue;
      }
      const match = byName.get(local.name.trim().toLowerCase());
      if (match && !usedIds.has(match.Id)) {
        usedIds.add(match.Id);
        await this.prisma.customer.update({
          where: { id: local.id },
          data: { quickbooksCustomerId: match.Id, syncStatus: 'SYNCED', lastSyncedAt: now },
        });
        linked++;
      }
    }

    // Pull-create: QuickBooks customers with no local counterpart become local
    // records, already linked. QuickBooks owns the live A/R balance, so the
    // local opening balance stays empty.
    for (const qbo of active) {
      if (usedIds.has(qbo.Id)) continue;
      await this.prisma.customer.create({ data: this.customerCreateData(tenantId, qbo, now) });
      created++;
    }

    const summary = `QuickBooks customer sync: ${created} created, ${linked} linked, ${refreshed} refreshed (${active.length} QuickBooks customers)`;
    await this.prisma.syncLog.create({
      data: {
        tenantId,
        entityType: 'CUSTOMER',
        entityId: null,
        direction: 'INBOUND',
        status: 'SYNCED',
        message: summary,
      },
    });
    this.logger.log(summary);
    return { created, linked, refreshed, total: active.length };
  }

  private customerCreateData(
    tenantId: string,
    qbo: QboCustomer,
    now: Date,
  ): Prisma.CustomerUncheckedCreateInput {
    return {
      tenantId,
      name: qbo.DisplayName.trim(),
      company: qbo.CompanyName ?? null,
      email: qbo.PrimaryEmailAddr?.Address ?? null,
      phone: qbo.PrimaryPhone?.FreeFormNumber ?? null,
      mobile: qbo.Mobile?.FreeFormNumber ?? null,
      fax: qbo.Fax?.FreeFormNumber ?? null,
      website: qbo.WebAddr?.URI ?? null,
      ...addressFields(qbo.BillAddr),
      resaleNumber: qbo.ResaleNum ?? null,
      quickbooksCustomerId: qbo.Id,
      syncStatus: 'SYNCED',
      lastSyncedAt: now,
    };
  }

  async syncVendors(tenantId: string): Promise<VendorSyncSummary> {
    const params = await this.params(tenantId);
    const qboVendors = await queryAllVendors(params);
    const active = qboVendors.filter((v) => v.Active !== false);
    const byId = new Map(active.map((v) => [v.Id, v]));
    const byName = new Map(active.map((v) => [v.DisplayName.trim().toLowerCase(), v]));

    const suppliers = await this.prisma.supplier.findMany({
      where: { tenantId },
      select: { id: true, name: true, quickbooksVendorId: true },
    });

    const now = new Date();
    const usedIds = new Set(suppliers.map((s) => s.quickbooksVendorId).filter(Boolean) as string[]);
    const localNames = new Set(suppliers.map((s) => s.name.trim().toLowerCase()));
    let created = 0;
    let linked = 0;
    let refreshed = 0;
    let flagged = 0;

    for (const supplier of suppliers) {
      if (supplier.quickbooksVendorId) {
        const vendor = byId.get(supplier.quickbooksVendorId);
        if (vendor) {
          await this.prisma.supplier.update({
            where: { id: supplier.id },
            data: {
              quickbooksVendorName: vendor.DisplayName,
              qbStatus: 'CONNECTED',
              qbLastSyncedAt: now,
            },
          });
          refreshed++;
        } else {
          await this.prisma.supplier.update({
            where: { id: supplier.id },
            data: { qbStatus: 'ATTENTION' },
          });
          flagged++;
        }
        continue;
      }
      const match = byName.get(supplier.name.trim().toLowerCase());
      if (match && !usedIds.has(match.Id)) {
        usedIds.add(match.Id);
        await this.prisma.supplier.update({
          where: { id: supplier.id },
          data: {
            quickbooksVendorId: match.Id,
            quickbooksVendorName: match.DisplayName,
            qbStatus: 'CONNECTED',
            qbLastSyncedAt: now,
          },
        });
        linked++;
      }
    }

    // Pull-create: QuickBooks vendors with no local counterpart become local
    // suppliers, already mapped. Vendor names are tenant-unique, so a name that
    // exists locally but is linked to a different QuickBooks vendor is skipped.
    for (const qbo of active) {
      if (usedIds.has(qbo.Id)) continue;
      if (localNames.has(qbo.DisplayName.trim().toLowerCase())) continue;
      await this.prisma.supplier.create({ data: this.vendorCreateData(tenantId, qbo, now) });
      created++;
    }

    const summary = `QuickBooks vendor sync: ${created} created, ${linked} linked, ${refreshed} refreshed, ${flagged} need attention (${active.length} QuickBooks vendors)`;
    await this.prisma.syncLog.create({
      data: {
        tenantId,
        entityType: 'SUPPLIER',
        entityId: null,
        direction: 'INBOUND',
        status: flagged > 0 ? 'FAILED' : 'SYNCED',
        message: summary,
      },
    });
    this.logger.log(summary);
    return { created, linked, refreshed, flagged, total: active.length };
  }

  private vendorCreateData(
    tenantId: string,
    qbo: QboVendor,
    now: Date,
  ): Prisma.SupplierUncheckedCreateInput {
    const address = addressFields(qbo.BillAddr);
    return {
      tenantId,
      name: qbo.DisplayName.trim(),
      company: qbo.CompanyName ?? null,
      email: qbo.PrimaryEmailAddr?.Address ?? null,
      phone: qbo.PrimaryPhone?.FreeFormNumber ?? null,
      mobile: qbo.Mobile?.FreeFormNumber ?? null,
      fax: qbo.Fax?.FreeFormNumber ?? null,
      website: qbo.WebAddr?.URI ?? null,
      street: address.street,
      city: address.city,
      province: address.state,
      postalCode: address.zip,
      country: address.country,
      taxId: qbo.TaxIdentifier ?? null,
      quickbooksVendorId: qbo.Id,
      quickbooksVendorName: qbo.DisplayName,
      qbStatus: 'CONNECTED',
      qbLastSyncedAt: now,
    };
  }
}
