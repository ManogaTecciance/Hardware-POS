/**
 * Slice 5.5 — customer documents must not depend on `quickbooksDocumentType`.
 *
 * `quickbooksDocumentType` is external-integration metadata. It is nullable, and
 * after Slice 6 a tenant on `AccountingProviderKind.NONE` will have `null` on every
 * sale and return. These specs render the real thermal receipts and real A4
 * documents for exactly that shape, and assert the four failure modes the Product
 * Owner named cannot occur: no runtime exception, no blank title, no wrong
 * template, and no "QuickBooks" wording.
 *
 * A sale is created through the real pipeline and then has its document type
 * nulled, which is precisely the row shape Slice 6 will produce. Nulling it here
 * rather than adopting a provider keeps Slice 5 inert.
 *
 * Every null-metadata assertion is paired with a QuickBooks-metadata assertion, so
 * "the null case is safe" is never established by quietly changing the
 * QuickBooks case.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PrismaClient, Sale } from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { DocumentsService } from '../../../src/modules/documents/documents.service';
import { ReceiptsModule } from '../../../src/modules/receipts/receipts.module';
import { ReceiptsService } from '../../../src/modules/receipts/receipts.service';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { MANAGER_PIN, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let returns: ReturnsService;
let receipts: ReceiptsService;
let documents: DocumentsService;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      SalesModule,
      ReturnsModule,
      ReceiptsModule,
      DocumentsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  receipts = testModule.get(ReceiptsService);
  documents = testModule.get(DocumentsService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' , activeBranchId: null };
});

/** A fully paid sale. */
function paidSale(quantity = 1) {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

/** A credit sale — nothing paid, so today it maps to an INVOICE. */
function creditSale() {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [],
  });
}

/** A partially paid sale. */
function partialSale() {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 400 }],
  });
}

/**
 * Strip the external accounting metadata, producing exactly the row shape a
 * `NONE` tenant will have after Slice 6.
 */
async function clearExternalMetadata(saleId: string): Promise<void> {
  await prisma.sale.update({
    where: { id: saleId },
    data: { quickbooksDocumentType: null, quickbooksDocumentId: null, syncStatus: 'NOT_SYNCED' },
  });
}

async function thermalReceiptHtml(sale: Sale): Promise<string> {
  const { printJob } = await receipts.generateCustomer(tenant.tenantId, sale.id, owner.id);
  const row = await prisma.printJob.findUniqueOrThrow({ where: { id: printJob.id } });
  return row.html;
}

/** Assertions every customer-facing document must satisfy. */
function assertSafeDocument(html: string): void {
  expect(html.length).toBeGreaterThan(200);
  // No blank title.
  expect(html).toMatch(/<h1[^>]*>\s*\S/);
  // No stray "null"/"undefined" leaking into the rendered output.
  expect(html).not.toMatch(/>\s*(null|undefined)\s*</);
  // No claim about a system this tenant may not use.
  expect(html).not.toMatch(/QuickBooks/i);
  expect(html).not.toMatch(/Synced|Not synced/i);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7, 8, 9, 10 — thermal receipts with null external metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('thermal sale receipt with null external accounting metadata', () => {
  it('a fully paid sale renders a receipt', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);

    const html = await thermalReceiptHtml(sale);

    assertSafeDocument(html);
    expect(html).toContain('Sales Receipt');
    expect(html).toContain(sale.saleNumber);
  });

  it('a credit sale renders without an external document badge', async () => {
    const sale = await creditSale();
    await clearExternalMetadata(sale.id);

    const html = await thermalReceiptHtml(sale);

    assertSafeDocument(html);
    // The balance is what tells the customer this is unpaid — not a QuickBooks type.
    expect(html).toMatch(/Balance/i);
    expect(html).not.toContain('INVOICE');
  });

  it('a partially paid sale renders the correct document with its balance', async () => {
    const sale = await partialSale();
    await clearExternalMetadata(sale.id);

    const html = await thermalReceiptHtml(sale);

    assertSafeDocument(html);
    expect(html).toMatch(/Balance/i);
    expect(html).toContain(sale.saleNumber);
  });

  it('never throws, for every payment status', async () => {
    for (const make of [paidSale, creditSale, partialSale]) {
      const sale = await make();
      await clearExternalMetadata(sale.id);
      await expect(thermalReceiptHtml(sale)).resolves.toBeTruthy();
      await resetDatabase(prisma);
      tenant = await seedTileShopWithQuickBooks(prisma);
      owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' , activeBranchId: null };
    }
  });

  it('still writes a print job, so the print action is not lost', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);

    const { printJob, receiptNumber } = await receipts.generateCustomer(
      tenant.tenantId,
      sale.id,
      owner.id,
    );

    expect(receiptNumber).toBe(`RCP-${sale.saleNumber}`);
    expect(printJob.type).toBe('CUSTOMER_RECEIPT');
    expect(printJob.status).toBe('PENDING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15, 16 — the QuickBooks case is unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe('existing QuickBooks receipt output is unchanged', () => {
  it('a paid QuickBooks sale still prints its SALES_RECEIPT badge', async () => {
    const sale = await paidSale();

    const html = await thermalReceiptHtml(sale);

    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(html).toContain('SALES_RECEIPT');
  });

  it('a credit QuickBooks sale still prints its INVOICE badge', async () => {
    const sale = await creditSale();

    const html = await thermalReceiptHtml(sale);

    expect(sale.quickbooksDocumentType).toBe('INVOICE');
    expect(html).toContain('INVOICE');
  });

  it('nulling the metadata swaps the external badge for the LOCAL document kind', async () => {
    const sale = await paidSale();
    const withMetadata = await thermalReceiptHtml(sale);

    await clearExternalMetadata(sale.id);
    const withoutMetadata = await thermalReceiptHtml(sale);

    // Updated in Slice 6A. Before it, a null simply omitted the badge; now the
    // receipt states the locally-derived kind instead, so a tenant with no
    // accounting provider gets a real label rather than a gap.
    expect(withMetadata).toContain('<div class="badge">SALES_RECEIPT</div>');
    expect(withoutMetadata).toContain('<div class="badge">Receipt</div>');
    expect(withoutMetadata).not.toContain('SALES_RECEIPT');

    // Exactly one div differs — everything else is untouched, which is what makes
    // this a compatibility change rather than a redesign.
    const squash = (html: string): string => html.replace(/\s+/g, ' ').trim();
    expect(squash(withoutMetadata.replace('<div class="badge">Receipt</div>', ''))).toBe(
      squash(withMetadata.replace('<div class="badge">SALES_RECEIPT</div>', '')),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 — server-side A4 rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('server-side A4 document with null external accounting metadata', () => {
  it('renders a sale bill for a fully paid sale', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);

    const html = await documents.saleHtml(tenant.tenantId, sale.id);

    assertSafeDocument(html);
    expect(html).toContain(sale.saleNumber);
  });

  it('renders a sale bill for a credit sale, with the UNPAID watermark', async () => {
    const sale = await creditSale();
    await clearExternalMetadata(sale.id);

    const html = await documents.saleHtml(tenant.tenantId, sale.id);

    assertSafeDocument(html);
    // Payment status drives the watermark — a LOCAL financial fact, not an
    // external document type.
    expect(html).toContain('UNPAID');
  });

  it('renders a sale bill for a partially paid sale', async () => {
    const sale = await partialSale();
    await clearExternalMetadata(sale.id);

    const html = await documents.saleHtml(tenant.tenantId, sale.id);

    assertSafeDocument(html);
    expect(html).toMatch(/Balance due/i);
  });

  it('selects the same template with and without external metadata', async () => {
    const sale = await paidSale();
    const withMetadata = await documents.saleHtml(tenant.tenantId, sale.id);

    await clearExternalMetadata(sale.id);
    const withoutMetadata = await documents.saleHtml(tenant.tenantId, sale.id);

    // The A4 renderer never reads `quickbooksDocumentType` at all, so the output is
    // identical — the strongest possible form of "no wrong template".
    expect(withoutMetadata).toBe(withMetadata);
  });

  it('builds the document object without throwing', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);
    const row = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        items: true,
        payments: true,
        customer: true,
        branch: true,
        tenant: true,
      },
    });

    // Directly exercising the builder, so a null cannot hide behind the renderer.
    const document = documents.buildSaleDocument(tenant.tenantId, row as never);
    expect(document.title).toBeTruthy();
    expect(document.number).toBe(sale.saleNumber);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — return documents
// ─────────────────────────────────────────────────────────────────────────────

describe('return documents with null external accounting metadata', () => {
  /**
   * A completed partial return.
   *
   * A refund method the sale was not paid with requires manager approval — one of
   * the rules pinned by the Slice 3 return characterisation spec — so a STORE_CREDIT
   * refund against a CASH sale needs a token. Minted here rather than worked around,
   * so the fixture obeys the real rules.
   */
  async function completedReturn(refundMethod = 'CASH') {
    // Store credit additionally requires a saved (non-walk-in) customer, so the
    // store-credit fixture attaches one. Another real rule obeyed rather than
    // bypassed.
    const sale =
      refundMethod === 'STORE_CREDIT'
        ? await sales.complete(tenant.tenantId, owner, {
            branchId: tenant.branchId,
            registerId: tenant.registerId,
            customerId: tenant.creditCustomerId,
            items: [{ productId: tenant.productAId, quantity: 2 }],
            payments: [{ method: 'CASH', amount: 2000 }],
          })
        : await paidSale(2);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    let approvalToken: string | null = null;
    if (refundMethod !== 'CASH') {
      const approval = await returns.approve(
        tenant.tenantId,
        dto(ApproveReturnDto, {
          managerPin: MANAGER_PIN,
          originalSaleId: sale.id,
          refundTotal: 1000,
        }),
      );
      if (!approval.approved || !approval.approvalToken) {
        throw new Error(`Fixture approval refused: ${approval.reason ?? 'unknown'}`);
      }
      approvalToken = approval.approvalToken;
    }

    return returns.complete(
      tenant.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod,
        ...(approvalToken ? { approvalToken } : {}),
        items: [
          {
            saleItemId: saleItem.id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );
  }

  it('the A4 return document renders with null metadata', async () => {
    const ret = await completedReturn();
    await prisma.return.update({
      where: { id: ret.id },
      data: { quickbooksDocumentType: null, quickbooksDocumentId: null },
    });

    const html = await documents.returnHtml(tenant.tenantId, ret.id);

    assertSafeDocument(html);
    expect(html).toContain(ret.returnNumber);
  });

  it('the thermal return receipt label falls back to LOCAL semantics, never a blank badge', async () => {
    const ret = await completedReturn();
    await prisma.return.update({
      where: { id: ret.id },
      data: { quickbooksDocumentType: null },
    });

    const { html } = await returns.generateReceipt(tenant.tenantId, ret.id, owner.id);

    // Money back → "Refund Receipt". Before the Slice 5.5 correction a null fell
    // through to this same string by accident; now it is a stated local rule.
    expect(html).toContain('Refund Receipt');
    expect(html).not.toMatch(/<div class="badge">\s*<\/div>/);
    expect(html).not.toMatch(/QuickBooks/i);
  });

  it('a store-credit return with null metadata is labelled a Credit Note, not a Refund Receipt', async () => {
    const ret = await completedReturn('STORE_CREDIT');
    await prisma.return.update({
      where: { id: ret.id },
      data: { quickbooksDocumentType: null },
    });

    const { html } = await returns.generateReceipt(tenant.tenantId, ret.id, owner.id);

    // This is the bug the correction fixes: a null previously printed
    // "Refund Receipt" on what is actually a credit note.
    expect(html).toContain('Credit Note');
    expect(html).not.toContain('Refund Receipt');
  });

  it('existing QuickBooks return labels are unchanged', async () => {
    const cash = await completedReturn();
    expect(cash.quickbooksDocumentType).toBe('REFUND_RECEIPT');
    const cashHtml = (await returns.generateReceipt(tenant.tenantId, cash.id, owner.id)).html;
    expect(cashHtml).toContain('Refund Receipt');

    await resetDatabase(prisma);
    tenant = await seedTileShopWithQuickBooks(prisma);
    owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' , activeBranchId: null };

    const credit = await completedReturn('STORE_CREDIT');
    expect(credit.quickbooksDocumentType).toBe('CREDIT_MEMO');
    const creditHtml = (await returns.generateReceipt(tenant.tenantId, credit.id, owner.id)).html;
    // Still the QuickBooks wording, not the new local "Credit Note" label.
    expect(creditHtml).toContain('Credit Memo');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13 — serialization
// ─────────────────────────────────────────────────────────────────────────────

describe('sale serialization tolerates null external metadata', () => {
  it('sale details serialize with a null document type', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);

    const detail = await sales.getById(tenant.tenantId, sale.id);

    expect(detail.quickbooksDocumentType).toBeNull();
    expect(detail.saleNumber).toBe(sale.saleNumber);
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it('sale history serializes with a null document type', async () => {
    const sale = await paidSale();
    await clearExternalMetadata(sale.id);

    const page = await sales.list(tenant.tenantId, dto(class {} as never) as never);

    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it('the return detail serializes with a null document type', async () => {
    const sale = await paidSale(2);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    const ret = await returns.complete(
      tenant.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod: 'CASH',
        items: [
          {
            saleItemId: saleItem.id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );
    await prisma.return.update({
      where: { id: ret.id },
      data: { quickbooksDocumentType: null },
    });

    const detail = await returns.getById(tenant.tenantId, ret.id);

    expect(detail.quickbooksDocumentType).toBeNull();
    expect(() => JSON.stringify(detail)).not.toThrow();
  });
});
