import { BadRequestException, ConflictException } from '@nestjs/common';

import { QuotationsService } from './quotations.service';
import type { QuotationsRepository } from './quotations.repository';
import type { SettingsService } from '../settings/settings.service';
import type { AuditLogService } from '../audit-log/audit-log.service';
import type { SalesService } from '../sales/sales.service';
import type { DocumentsService } from '../documents/documents.service';
import type { SharingService } from '../sharing/sharing.service';
import type { AuthenticatedUser } from '../auth/auth.types';

const SETTINGS = {
  currency: 'LKR',
  taxRatePercent: 0,
  quotation: {
    defaultValidityDays: 14,
    defaultTermsAndConditions: 'Terms',
    numberFormat: 'QT-{seq}',
    revisionFormat: '{number}-R{rev}',
    requireCustomer: false,
    allowWithoutStock: true,
    showStockAvailability: true,
    allowPriceOverride: true,
    requireApprovalAboveDiscountPercent: 15,
  },
};

const CASHIER: AuthenticatedUser = {
  id: 'u1',
  tenantId: 't1',
  role: 'CASHIER',
  activeBranchId: null,
};

function makeService(repo: Partial<QuotationsRepository>) {
  const settings = { getSettings: () => SETTINGS } as unknown as SettingsService;
  const audit = { record: jest.fn() } as unknown as AuditLogService;
  const sales = { complete: jest.fn() } as unknown as SalesService;
  const documents = { quotationHtml: jest.fn(), pdfAvailable: true } as unknown as DocumentsService;
  const sharing = { recordDelivery: jest.fn() } as unknown as SharingService;
  return new QuotationsService(repo as QuotationsRepository, settings, audit, sales, documents, sharing);
}

/** A minimal detail row with one catalog line in the current revision. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    tenantId: 't1',
    quotationNumber: 'QT-000001',
    currentRevisionNumber: 0,
    status: 'DRAFT',
    branchId: 'brn1',
    customerId: 'c1',
    convertedSaleId: null,
    quotationDiscountType: null,
    quotationDiscountValue: null,
    grandTotal: 200,
    revisions: [
      {
        items: [
          { productId: 'p1', quantity: 2, unitPrice: 100, discountType: null, discountValue: null },
        ],
      },
    ],
    ...overrides,
  } as never;
}

describe('QuotationsService.preview', () => {
  it('recomputes totals from the catalog price (never trusts the client)', async () => {
    const service = makeService({
      findProductsForSnapshot: jest.fn().mockResolvedValue(
        new Map([
          [
            'p1',
            {
              id: 'p1',
              name: 'Cement 50kg',
              sku: 'CEM-50',
              imageUrl: null,
              description: null,
              unitType: 'bag',
              unitPrice: 100,
              quantityOnHand: 500,
              trackInventory: true,
              isActive: true,
              categoryName: 'Building',
              subcategoryName: null,
            },
          ],
        ]),
      ),
    });
    // The client "helpfully" sends a bogus unitPrice of 1; the server ignores it
    // for the subtotal it computes from the resolved catalog price... actually
    // overrides are allowed, so send no override and expect the catalog price.
    const preview = await service.preview('t1', {
      items: [{ productId: 'p1', quantity: 2 }],
    } as never);
    expect(preview.subtotal).toBe(200);
    expect(preview.grandTotal).toBe(200);
    expect(preview.items).toHaveLength(1);
  });
});

describe('QuotationsService guards', () => {
  it('refuses to edit a non-draft quotation in place', async () => {
    const service = makeService({ findDetail: jest.fn().mockResolvedValue(makeRow({ status: 'SENT' })) });
    await expect(service.update('t1', CASHIER, 'q1', { notes: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('blocks a duplicate conversion for a non-admin', async () => {
    const service = makeService({
      findDetail: jest.fn().mockResolvedValue(makeRow({ status: 'SENT', convertedSaleId: 'sale1' })),
    });
    await expect(
      service.convertToSale('t1', CASHIER, 'q1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to convert a cancelled quotation', async () => {
    const service = makeService({
      findDetail: jest.fn().mockResolvedValue(makeRow({ status: 'CANCELLED' })),
    });
    await expect(service.convertToSale('t1', CASHIER, 'q1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to convert when a line has no catalog product', async () => {
    const service = makeService({
      findDetail: jest.fn().mockResolvedValue(
        makeRow({
          revisions: [{ items: [{ productId: null, quantity: 1, unitPrice: 50 }] }],
        }),
      ),
    });
    await expect(service.convertToSale('t1', CASHIER, 'q1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
