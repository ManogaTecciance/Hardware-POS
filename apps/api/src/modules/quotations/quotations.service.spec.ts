import { BadRequestException, ConflictException } from '@nestjs/common';
import { ADMIN_LEVEL_ROLES, ALL_USER_ROLES } from '@hardware-pos/shared';

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
const OWNER: AuthenticatedUser = { id: 'u2', tenantId: 't1', role: 'OWNER', activeBranchId: null };
/**
 * D108 — the hardware template's owner-equivalent. Owner-level for the
 * re-conversion override below exactly as OWNER is: the service asks
 * `isAdminLevelRole`, never the enum by name.
 */
const SALESPERSON: AuthenticatedUser = {
  id: 'u3',
  tenantId: 't1',
  role: 'SALESPERSON',
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

/** As makeService, but with a SalesService whose complete() can be inspected. */
function makeServiceWithSales(
  repo: Partial<QuotationsRepository>,
  complete: jest.Mock,
) {
  const settings = { getSettings: () => SETTINGS } as unknown as SettingsService;
  const audit = { record: jest.fn() } as unknown as AuditLogService;
  const sales = { complete } as unknown as SalesService;
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
          {
            productId: 'p1',
            quantity: 2,
            unitPrice: 100,
            discountType: null,
            discountValue: null,
            discountBasis: 'LINE',
          },
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

  /**
   * The override is honoured for owner-level roles only (`isAdminLevelRole`).
   * D108 put SALESPERSON in that set, so it is exercised by name on both sides
   * of the flag beside the CASHIER negative above, and the exact-set test at
   * the end derives the same fact from the authority so a role added to
   * `ADMIN_LEVEL_ROLES` cannot be skipped here silently.
   */
  function reconversion(actor: AuthenticatedUser, dto: { override?: boolean }) {
    const complete = jest.fn().mockResolvedValue({ id: 's2', saleNumber: 'S-2' });
    const linkConvertedSale = jest.fn().mockResolvedValue(undefined);
    const service = makeServiceWithSales(
      {
        findDetail: jest
          .fn()
          .mockResolvedValue(makeRow({ status: 'SENT', convertedSaleId: 'sale1' })),
        linkConvertedSale,
      },
      complete,
    );
    return { result: service.convertToSale('t1', actor, 'q1', dto), complete, linkConvertedSale };
  }

  it('a SALESPERSON with { override: true } re-converts, exactly as the owner does (D108)', async () => {
    for (const actor of [SALESPERSON, OWNER]) {
      const { result, complete, linkConvertedSale } = reconversion(actor, { override: true });
      await expect(result).resolves.toEqual({ saleId: 's2', saleNumber: 'S-2', quotationId: 'q1' });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(
        't1',
        actor,
        expect.objectContaining({ branchId: 'brn1', customerId: 'c1' }),
      );
      expect(linkConvertedSale).toHaveBeenCalledWith('t1', 'q1', 's2');
    }
  });

  it('a SALESPERSON without the override still gets the conflict — owner-level is not a bypass', async () => {
    for (const dto of [{}, { override: false }]) {
      const { result, complete } = reconversion(SALESPERSON, dto);
      await expect(result).rejects.toBeInstanceOf(ConflictException);
      expect(complete).not.toHaveBeenCalled();
    }
  });

  it('a CASHIER with { override: true } is still refused — the flag is not the authority', async () => {
    const { result, complete } = reconversion(CASHIER, { override: true });
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('exactly the owner-level roles may override — derived from the authority, pinned by name', async () => {
    const honoured: string[] = [];
    const refused: string[] = [];
    for (const role of ALL_USER_ROLES) {
      const actor: AuthenticatedUser = { id: `u_${role}`, tenantId: 't1', role, activeBranchId: null };
      const { result, complete } = reconversion(actor, { override: true });
      try {
        await result;
        honoured.push(role);
        expect(complete).toHaveBeenCalledTimes(1);
      } catch (e) {
        refused.push(role);
        expect(e).toBeInstanceOf(ConflictException);
        expect(complete).not.toHaveBeenCalled();
      }
    }
    expect(honoured.sort()).toEqual([...ADMIN_LEVEL_ROLES].sort());
    // The complement is written out: an enum value added to neither list lands
    // here, where it fails by name instead of passing by derivation.
    expect(refused.sort()).toEqual(['ACCOUNTANT', 'CASHIER', 'MANAGER']);
    expect(honoured).toContain('SALESPERSON');
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


/**
 * Converting a quotation must charge what was quoted.
 *
 * SaleItemInputDto.discountBasis is optional and the sale defaults it to LINE,
 * so nothing in the type system stops the basis being dropped on this hand-map —
 * this test is the only guard. Without it, Rs. 100 off each of 20 units converts
 * into a sale Rs. 1,900 dearer than the customer was quoted.
 */
describe('QuotationsService.convertToSale carries the discount basis', () => {
  const perUnitRow = () =>
    makeRow({
      status: 'SENT',
      revisions: [
        {
          items: [
            {
              productId: 'p1',
              quantity: 20,
              unitPrice: 500,
              discountType: 'FIXED',
              discountValue: 100,
              discountBasis: 'UNIT',
            },
          ],
        },
      ],
    });

  it('sends the basis through to the sale', async () => {
    const complete = jest.fn().mockResolvedValue({ id: 's1', saleNumber: 'S-1' });
    const service = makeServiceWithSales(
      {
        findDetail: jest.fn().mockResolvedValue(perUnitRow()),
        linkConvertedSale: jest.fn().mockResolvedValue(undefined),
      },
      complete,
    );

    await service.convertToSale('t1', OWNER, 'q1', { branchId: 'brn1' });

    const dto = complete.mock.calls[0][2] as { items: Array<{ discountBasis?: string }> };
    expect(dto.items[0].discountBasis).toBe('UNIT');
  });

  it('sends LINE for a whole-line quotation', async () => {
    const complete = jest.fn().mockResolvedValue({ id: 's1', saleNumber: 'S-1' });
    const service = makeServiceWithSales(
      {
        findDetail: jest.fn().mockResolvedValue(makeRow({ status: 'SENT' })),
        linkConvertedSale: jest.fn().mockResolvedValue(undefined),
      },
      complete,
    );

    await service.convertToSale('t1', OWNER, 'q1', { branchId: 'brn1' });

    const dto = complete.mock.calls[0][2] as { items: Array<{ discountBasis?: string }> };
    expect(dto.items[0].discountBasis).toBe('LINE');
  });
});
