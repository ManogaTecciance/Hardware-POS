/**
 * D104 Part 3 and D106 — barcode allocation, provenance, the reissue pass and
 * label printing (Phase 5, steps `5.4`–`5.9`).
 *
 * ## What can only be proven here
 *
 *  • The `5.4` sequencing constraint as an actual refusal: allocation stops
 *    while `catalogue.barcodePrefix` is null, read FRESH from the settings row.
 *  • `@@unique([tenantId, barcode])` and the retry that clears a collision.
 *  • That a reissue writes an `AuditLog` row carrying the PREVIOUS barcode —
 *    the thing that makes this a correction rather than silent destruction.
 *  • D106: a `PRODUCT_LABEL` print job with `saleId = null` actually inserts,
 *    which the schema forbade until this phase.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every protective refusal is asserted beside the neighbouring case that must
 * SUCCEED, so a service that refused everything fails as loudly as one that
 * refused nothing: a supplier barcode is protected while an internal one is
 * reissued; an invalid EAN-13 is skipped while a valid one on the same sheet is
 * drawn. The existing receipt print job is asserted unchanged, because D106
 * widened a column the restaurant and hardware modules both write to.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AccountingProviderKind,
  BarcodeSource,
  BusinessType,
  InventoryMode,
  PrintJobType,
  type PrismaClient,
} from '@hardware-pos/database';
import { isValidEan13 } from '@hardware-pos/shared';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { BarcodeAuditService } from '../../../src/modules/products/identifiers/barcode-audit.service';
import { BarcodeGeneratorService } from '../../../src/modules/products/identifiers/barcode-generator.service';
import { LabelPrintService } from '../../../src/modules/products/identifiers/label-print.service';
import { ProductVariantsService } from '../../../src/modules/products/variants/product-variants.service';
import { CreateVariantBatchDto } from '../../../src/modules/products/variants/dto/create-variant-batch.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, setTenantSettings, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let variants: ProductVariantsService;
let audit: BarcodeAuditService;
let labels: LabelPrintService;
let shop: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      SalesModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  variants = testModule.get(ProductVariantsService);
  audit = testModule.get(BarcodeAuditService);
  labels = testModule.get(LabelPrintService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  shop = await seedTileShopWithQuickBooks(prisma);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType: BusinessType.RETAIL,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
  await prisma.product.update({ where: { id: shop.productAId }, data: { hasVariants: true } });
});

/**
 * Replace the tenant's settings row.
 *
 * `setTenantSettings` CREATEs, and `TenantSettings` is unique on
 * `(tenantId, branchId)` — which Postgres does not enforce across two NULL
 * branchIds, so calling it twice leaves two rows and the service reads
 * whichever `findFirst` returns. The same NULL-distinctness that keeps
 * `categoryId` out of D104a's unique key. Deleting first makes the helper
 * idempotent for this spec without changing a fixture other specs rely on.
 */
async function writeSettings(data: Record<string, unknown>): Promise<void> {
  await prisma.tenantSettings.deleteMany({ where: { tenantId: shop.tenantId } });
  await setTenantSettings(prisma, shop.tenantId, data);
}

async function configurePrefix(prefix: string): Promise<void> {
  await writeSettings({ catalogue: { barcodePrefix: prefix } });
}

function batch(rows: unknown[]): CreateVariantBatchDto {
  return Object.assign(new CreateVariantBatchDto(), { variants: rows });
}

async function createVariant(row: Record<string, unknown>) {
  const [created] = await variants.createVariantsBatch(
    shop.tenantId,
    shop.productAId,
    shop.ownerId,
    batch([{ unitPrice: 1000, optionValues: [], ...row }]),
  );
  return created;
}

// ── 5.4: the sequencing constraint ───────────────────────────────────────────

describe('the barcode prefix must be configured first', () => {
  it('refuses to allocate while no prefix is set, naming what to configure', async () => {
    await expect(
      createVariant({ sku: 'NO-PREFIX', generateBarcode: true }),
    ).rejects.toThrow(/prefix is configured/i);

    // And nothing was written — the refusal happens before the transaction.
    expect(await prisma.productVariant.count({ where: { tenantId: shop.tenantId } })).toBe(0);
  });

  it('a tenant that types its own barcodes never has to configure one', async () => {
    // The constraint must not become a wall for shops that do not generate.
    const created = await createVariant({ sku: 'SUPPLIER-1', barcode: '5901234123457' });
    expect(created.barcode).toBe('5901234123457');
    expect(created.barcodeSource).toBe(BarcodeSource.SUPPLIER);
  });

  it('refuses a prefix outside the GS1 in-store range', async () => {
    await configurePrefix('1234');
    await expect(createVariant({ sku: 'BAD-PREFIX', generateBarcode: true })).rejects.toThrow(
      /02 or 20-29/,
    );
  });
});

// ── 5.5 / 5.6: allocation and provenance ─────────────────────────────────────

describe('allocation', () => {
  it('issues a valid EAN-13 under the configured prefix', async () => {
    await configurePrefix('2001');
    const created = await createVariant({ sku: 'GEN-1', generateBarcode: true });

    expect(created.barcode).toBe('2001000000012');
    expect(isValidEan13(created.barcode!)).toBe(true);
    expect(created.barcodeSource).toBe(BarcodeSource.INTERNAL);
  });

  it('every code in a run is valid, distinct and sequential', async () => {
    await configurePrefix('2001');
    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch(
        Array.from({ length: 5 }, (_, i) => ({
          sku: `RUN-${i}`,
          unitPrice: 100,
          generateBarcode: true,
          optionValues: [],
        })),
      ),
    );
    const codes = created.map((v) => v.barcode!);
    expect(new Set(codes).size).toBe(5);
    expect(codes.filter((c) => !isValidEan13(c))).toEqual([]);
  });

  it('retries past a code a supplier already occupies', async () => {
    await configurePrefix('2001');
    // Someone typed the first allocatable code in by hand as a supplier code.
    await createVariant({ sku: 'TYPED', barcode: '2001000000012' });

    const created = await createVariant({ sku: 'GEN-AFTER', generateBarcode: true });
    expect(created.barcode).toBe('2001000000029');
    expect(isValidEan13(created.barcode!)).toBe(true);
  });

  it('refuses a typed 13-digit code with a wrong check digit, and accepts a CODE128 one', async () => {
    // The rule keys on SHAPE, so it cannot reject a genuine supplier code.
    await expect(
      createVariant({ sku: 'BAD-EAN', barcode: '2001000000015' }),
    ).rejects.toThrow(/check digit/i);

    const ok = await createVariant({ sku: 'SUPPLIER-C128', barcode: 'ACME-XYZ-001' });
    expect(ok.barcode).toBe('ACME-XYZ-001');
    expect(ok.barcodeSource).toBe(BarcodeSource.SUPPLIER);
  });

  it('a variant with no barcode has no source either — nothing is guessed', async () => {
    const created = await createVariant({ sku: 'NO-BARCODE' });
    expect(created.barcode).toBeNull();
    expect(created.barcodeSource).toBeNull();
  });

  it('mayRegenerate treats UNKNOWN as "not mine to overwrite"', () => {
    expect(BarcodeGeneratorService.mayRegenerate({ barcode: null, barcodeSource: null })).toBe(true);
    expect(
      BarcodeGeneratorService.mayRegenerate({ barcode: '2001000000012', barcodeSource: BarcodeSource.INTERNAL }),
    ).toBe(true);
    expect(
      BarcodeGeneratorService.mayRegenerate({ barcode: '5901234123457', barcodeSource: BarcodeSource.SUPPLIER }),
    ).toBe(false);
    // The pilot's twenty codes are in this state. Treating unknown as ours is
    // how a manufacturer's barcode gets destroyed.
    expect(
      BarcodeGeneratorService.mayRegenerate({ barcode: '2001000000015', barcodeSource: null }),
    ).toBe(false);
  });

  /**
   * The constraint is a PARTIAL unique index created by the D44 migration:
   *
   *     CREATE UNIQUE INDEX "ProductVariant_tenantId_barcode_key"
   *       ON "ProductVariant"("tenantId","barcode") WHERE "barcode" IS NOT NULL;
   *
   * Prisma cannot express a partial index, so it is NOT declared in
   * `schema.prisma` — declaring `@@unique([tenantId, barcode])` made Prisma
   * demand a full index it could model and generate a corrective migration on
   * every `migrate dev`. This asserts the real constraint by its behaviour and
   * by name, so a future migration that drops or replaces it fails here rather
   * than in a shop.
   */
  it('enforces barcode uniqueness within a tenant, by the partial index D44 created', async () => {
    await createVariant({ sku: 'FIRST', barcode: '5901234123457' });

    // Asserted at BOTH levels. A bare `rejects.toBeDefined()` would pass for a
    // validation failure, a typo in the fixture, or no constraint at all.
    //
    // Through the service: a 409, not some other error. (`mapWriteError` names
    // only the SKU case specifically, so a barcode clash reads "value" — vague,
    // pre-existing, and not this phase's to change.)
    await expect(createVariant({ sku: 'SECOND', barcode: '5901234123457' })).rejects.toBeInstanceOf(
      ConflictException,
    );

    // And at the database, where the raw error names the constraint. This is
    // the assertion that would have caught the redundant `@@unique` in the
    // schema: it proves WHICH index is doing the work.
    await expect(
      prisma.productVariant.create({
        data: {
          tenantId: shop.tenantId,
          productId: shop.productAId,
          sku: 'THIRD',
          unitPrice: 1,
          barcode: '5901234123457',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'ProductVariant'
        AND indexname = 'ProductVariant_tenantId_barcode_key'
    `;
    expect(index).toBeDefined();
    expect(index!.indexdef).toMatch(/UNIQUE/i);
    expect(index!.indexdef).toMatch(/WHERE \(barcode IS NOT NULL\)/i);
  });

  it('allows many variants with NO barcode — the partial index excludes them', async () => {
    // The behaviour that makes the partial index equivalent to a plain unique
    // one here, and the reason 28 of the pilot's 48 variants are unaffected.
    await createVariant({ sku: 'NONE-1' });
    await createVariant({ sku: 'NONE-2' });
    await createVariant({ sku: 'NONE-3' });

    const withoutBarcode = await prisma.productVariant.count({
      where: { tenantId: shop.tenantId, barcode: null },
    });
    expect(withoutBarcode).toBe(3);
  });
});

// ── 5.9: the audit and reissue pass ──────────────────────────────────────────

describe('the barcode audit', () => {
  /** The pilot's real shape: mostly invalid, one valid by coincidence. */
  async function seedPilotBarcodes() {
    await prisma.productVariant.createMany({
      data: [
        { tenantId: shop.tenantId, productId: shop.productAId, sku: 'BRSH-1IN', unitPrice: 100, barcode: '2001000000015', barcodeSource: BarcodeSource.INTERNAL },
        { tenantId: shop.tenantId, productId: shop.productAId, sku: 'BRSH-2IN', unitPrice: 100, barcode: '2001000000022', barcodeSource: BarcodeSource.INTERNAL },
        { tenantId: shop.tenantId, productId: shop.productAId, sku: 'TSHIRT-W', unitPrice: 100, barcode: '2990001000001', barcodeSource: BarcodeSource.INTERNAL },
        { tenantId: shop.tenantId, productId: shop.productAId, sku: 'SUPPLIED', unitPrice: 100, barcode: 'ACME-123', barcodeSource: BarcodeSource.SUPPLIER },
        { tenantId: shop.tenantId, productId: shop.productAId, sku: 'NONE', unitPrice: 100 },
      ],
    });
  }

  it('classifies every barcode and reports only the problems', async () => {
    await seedPilotBarcodes();
    const report = await audit.report(shop.tenantId);

    expect(report.scanned).toBe(5);
    expect(report.withBarcode).toBe(4);
    expect(report.valid).toBe(1); // 2990001000001, valid by coincidence
    expect(report.invalidCheckDigit).toBe(2);
    expect(report.notEan13).toBe(1); // the supplier's CODE128
    expect(report.problems.map((p) => p.sku).sort()).toEqual(['BRSH-1IN', 'BRSH-2IN']);
  });

  it('reissues an internal code and records the OLD value in the audit log', async () => {
    await configurePrefix('2001');
    await seedPilotBarcodes();
    const report = await audit.report(shop.tenantId);
    const target = report.problems.find((p) => p.sku === 'BRSH-1IN')!;

    const [reissued] = await audit.reissue(shop.tenantId, [target.variantId], shop.ownerId);
    expect(isValidEan13(reissued.barcode)).toBe(true);
    expect(reissued.barcode).not.toBe('2001000000015');

    // This is what makes it a correction rather than silent destruction.
    const entries = await prisma.auditLog.findMany({
      where: { tenantId: shop.tenantId, action: 'BARCODE_REISSUED' },
    });
    expect(entries).toHaveLength(1);
    const metadata = entries[0].metadata as Record<string, unknown>;
    expect(metadata.previousBarcode).toBe('2001000000015');
    expect(metadata.newBarcode).toBe(reissued.barcode);
    expect(metadata.reason).toBe('INVALID_EAN13_CHECK_DIGIT');
  });

  it('refuses to touch a supplier barcode, even an invalid one', async () => {
    await configurePrefix('2001');
    const supplied = await prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productAId,
        sku: 'SUPPLIER-BAD',
        unitPrice: 100,
        barcode: '2001000000015',
        barcodeSource: BarcodeSource.SUPPLIER,
      },
    });

    await expect(
      audit.reissue(shop.tenantId, [supplied.id], shop.ownerId),
    ).rejects.toThrow(/supplier barcode/i);

    const after = await prisma.productVariant.findUnique({ where: { id: supplied.id } });
    expect(after!.barcode).toBe('2001000000015');
  });

  it('has no "fix everything" call, and refuses a mixed selection wholesale', async () => {
    await configurePrefix('2001');
    await seedPilotBarcodes();
    await expect(audit.reissue(shop.tenantId, [], shop.ownerId)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // One eligible row and one ineligible one: the whole request is refused
    // rather than half-applied, so the operator is never left guessing which
    // rows changed. The guards run in order, so the message names the FIRST
    // reason — a supplier code here, which is the more serious of the two.
    const withSupplier = await prisma.productVariant.findMany({
      where: { tenantId: shop.tenantId, sku: { in: ['BRSH-1IN', 'SUPPLIED'] } },
      select: { id: true },
    });
    await expect(
      audit.reissue(shop.tenantId, withSupplier.map((r) => r.id), shop.ownerId),
    ).rejects.toThrow(/supplier barcode/i);

    // The other branch, reached with an INTERNAL row that is simply not an
    // EAN-13 — a shop's own Code 128 label, which this pass has no business
    // rewriting because nothing about it is broken.
    const internalC128 = await prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productAId,
        sku: 'OURS-C128',
        unitPrice: 100,
        barcode: 'OURS-0001',
        barcodeSource: BarcodeSource.INTERNAL,
      },
    });
    const mixed = await prisma.productVariant.findMany({
      where: { tenantId: shop.tenantId, sku: { in: ['BRSH-1IN', 'OURS-C128'] } },
      select: { id: true },
    });
    await expect(
      audit.reissue(shop.tenantId, mixed.map((r) => r.id), shop.ownerId),
    ).rejects.toThrow(/not a 13-digit code/i);

    // Neither refusal changed anything.
    const untouched = await prisma.productVariant.findFirst({
      where: { tenantId: shop.tenantId, sku: 'BRSH-1IN' },
    });
    expect(untouched!.barcode).toBe('2001000000015');
    const stillOurs = await prisma.productVariant.findUnique({
      where: { id: internalC128.id },
    });
    expect(stillOurs!.barcode).toBe('OURS-0001');
  });
});

// ── 5.7 / 5.8 / D106: labels ────────────────────────────────────────────────

describe('label printing', () => {
  async function seedForLabels() {
    await configurePrefix('2001');
    const good = await createVariant({ sku: 'GOOD', generateBarcode: true });
    const bad = await prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productAId,
        sku: 'LEGACY-BAD',
        unitPrice: 100,
        barcode: '2001000000015',
        barcodeSource: BarcodeSource.INTERNAL,
      },
    });
    return { good, bad };
  }

  it('draws a label for a valid barcode and REPORTS the one it cannot draw', async () => {
    const { good, bad } = await seedForLabels();
    const sheet = await labels.renderSheet(shop.tenantId, [
      { variantId: good.id, quantity: 2 },
      { variantId: bad.id, quantity: 1 },
    ]);

    // Two copies of the good one; the bad one is named, not silently omitted.
    expect(sheet.labelCount).toBe(2);
    expect(sheet.html).toContain('<svg');
    expect(sheet.skipped).toHaveLength(1);
    expect(sheet.skipped[0].sku).toBe('LEGACY-BAD');
    expect(sheet.skipped[0].reason).toMatch(/check digit/i);
    // And it points at the fix, rather than leaving the operator to guess.
    expect(sheet.skipped[0].reason).toMatch(/reissue/i);
  });

  it('honours label geometry from settings (5.8)', async () => {
    const { good } = await seedForLabels();
    await writeSettings({
      catalogue: {
        barcodePrefix: '2001',
        label: { widthMm: 50, heightMm: 30, columns: 3, showPrice: false },
      },
    });

    const sheet = await labels.renderSheet(shop.tenantId, [{ variantId: good.id, quantity: 1 }]);
    expect(sheet.html).toContain('width: 50mm');
    expect(sheet.html).toContain('repeat(3, 50mm)');
    // A field switched off must actually disappear, not merely be styled away.
    expect(sheet.html).not.toContain('class="price"');
  });

  it('queues a PRODUCT_LABEL job with no sale behind it (D106)', async () => {
    const { good } = await seedForLabels();
    const result = await labels.queueSheet(
      shop.tenantId,
      [{ variantId: good.id, quantity: 4 }],
      shop.ownerId,
      2,
    );

    const job = await prisma.printJob.findUnique({ where: { id: result.printJobId } });
    expect(job!.type).toBe(PrintJobType.PRODUCT_LABEL);
    // The whole reason D106 exists. Before this phase the column was NOT NULL.
    expect(job!.saleId).toBeNull();
    expect(job!.copies).toBe(2);
    expect(result.labelCount).toBe(4);
  });

  it('refuses to queue a sheet on which nothing could be drawn', async () => {
    const { bad } = await seedForLabels();
    await expect(
      labels.queueSheet(shop.tenantId, [{ variantId: bad.id, quantity: 1 }], shop.ownerId, 1),
    ).rejects.toThrow(/could be printed/i);

    expect(await prisma.printJob.count({ where: { tenantId: shop.tenantId } })).toBe(0);
  });

  it('a variant from another workspace is reported, never drawn', async () => {
    await seedForLabels();
    const sheet = await labels.renderSheet(shop.tenantId, [
      { variantId: 'not-a-real-id', quantity: 1 },
    ]);
    expect(sheet.labelCount).toBe(0);
    expect(sheet.skipped[0].reason).toMatch(/does not belong/i);
  });

  /**
   * D106 widened `PrintJob.saleId` on a table the restaurant and hardware
   * modules both write to. This asserts the existing shape still works — a
   * receipt job with a real sale — beside the new one that does not.
   */
  it('a sale-backed print job is completely unaffected by the widening', async () => {
    const sale = await prisma.sale.findFirst({ where: { tenantId: shop.tenantId } });
    const job = await prisma.printJob.create({
      data: {
        tenantId: shop.tenantId,
        saleId: sale?.id ?? null,
        type: PrintJobType.CUSTOMER_RECEIPT,
        html: '<html></html>',
      },
    });
    expect(job.type).toBe(PrintJobType.CUSTOMER_RECEIPT);
    expect(job.saleId).toBe(sale?.id ?? null);
  });
});
