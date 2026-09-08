/**
 * D58 / plan Q1 — reconstruct SaleItem rows for restaurant sales settled
 * BEFORE the projection existed.
 *
 * Every closed `TableSession` links its Sale through `finalSaleId`, and the
 * order items still hold the snapshots frozen at submit time — so this is a
 * field-for-field COPY of data that already exists, never a recomputation.
 *
 * Rules (convergence plan §12.3.2):
 *  - Dry-run by default; `--write` applies.
 *  - Idempotent: a sale that already has items is skipped.
 *  - Every reconstructed row is stamped `backfilledAt`, so reconstructed
 *    financial detail stays distinguishable from natively-written detail
 *    forever.
 *  - Per-sale invariant: Σ lineTotal must equal the sale's stored subtotal.
 *    A sale that disagrees gets NO rows and a report line — a wrong
 *    reconstruction is worse than an absent one, because nothing would
 *    distinguish it from truth later.
 *  - Also stamps the D58 fulfilment facts (fulfilmentKind, channel,
 *    sourceRef, servedBy) the header could not carry when it was written.
 *
 * Usage:
 *   npx tsx prisma/backfill-restaurant-sale-items.ts            # dry run, all tenants
 *   npx tsx prisma/backfill-restaurant-sale-items.ts --write
 */
import { FulfilmentKind, OrderChannel, Prisma, PrismaClient, SaleItemSourceKind } from '@prisma/client';

const prisma = new PrismaClient();

interface Report {
  scanned: number;
  reconstructed: number;
  linesWritten: number;
  skippedAlreadyPresent: number;
  discrepant: { saleId: string; saleNumber: string; sum: string; subtotal: string }[];
}

async function main() {
  const write = process.argv.includes('--write');
  const backfilledAt = new Date();
  const report: Report = {
    scanned: 0,
    reconstructed: 0,
    linesWritten: 0,
    skippedAlreadyPresent: 0,
    discrepant: [],
  };

  const sessions = await prisma.tableSession.findMany({
    where: { status: 'CLOSED', finalSaleId: { not: null } },
    select: {
      id: true,
      tenantId: true,
      waiterUserId: true,
      finalSaleId: true,
      orders: {
        select: {
          channel: true,
          items: {
            where: { status: { not: 'VOIDED' } },
            include: { modifiers: true },
          },
        },
      },
    },
  });

  for (const session of sessions) {
    report.scanned += 1;
    const sale = await prisma.sale.findUnique({
      where: { id: session.finalSaleId! },
      select: {
        id: true,
        saleNumber: true,
        subtotal: true,
        sourceRefId: true,
        _count: { select: { items: true } },
      },
    });
    if (!sale) continue;
    if (sale._count.items > 0) {
      report.skippedAlreadyPresent += 1;
      continue;
    }

    const items = session.orders.flatMap((o) => o.items);
    const lines = items.map((item) => {
      const lineTotal = item.unitPrice.plus(item.modifierTotal).mul(item.quantity);
      return { item, lineTotal };
    });
    const sum = lines.reduce((acc, l) => acc.plus(l.lineTotal), new Prisma.Decimal(0));

    if (!sum.equals(sale.subtotal)) {
      // No rows for a sale that disagrees with its own lines. Reported, not
      // forced — the operator decides what the discrepancy means.
      report.discrepant.push({
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        sum: sum.toFixed(2),
        subtotal: sale.subtotal.toFixed(2),
      });
      continue;
    }

    // A session's orders share a channel in practice; if they ever disagreed,
    // DINE_IN is the close path that produced the sale.
    const channel =
      session.orders.every((o) => o.channel === 'TAKEAWAY') && session.orders.length > 0
        ? OrderChannel.TAKEAWAY
        : OrderChannel.DINE_IN;

    report.reconstructed += 1;
    report.linesWritten += lines.length;

    if (!write) continue;
    await prisma.$transaction(async (tx) => {
      for (const { item, lineTotal } of lines) {
        const saleItem = await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: item.productId,
            productVariantId: item.productVariantId,
            productName: item.menuItemName,
            variantNameSnapshot: item.variantNameSnapshot,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            modifierTotal: item.modifierTotal,
            notes: item.specialInstructions,
            sourceKind: SaleItemSourceKind.RESTAURANT_ORDER_ITEM,
            sourceItemId: item.id,
            lineSubtotal: lineTotal,
            lineTotal,
            backfilledAt,
          },
        });
        if (item.modifiers.length > 0) {
          await tx.saleItemModifier.createMany({
            data: item.modifiers.map((m) => ({
              tenantId: session.tenantId,
              saleItemId: saleItem.id,
              modifierOptionId: m.modifierOptionId,
              optionName: m.optionName,
              groupName: m.groupName,
              priceDelta: m.priceDelta,
            })),
          });
        }
      }
      await tx.sale.update({
        where: { id: sale.id },
        data: {
          fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
          channel,
          sourceRefKind: 'TABLE_SESSION',
          sourceRefId: session.id,
          servedByUserId: session.waiterUserId,
        },
      });
    });
  }

  console.log(`${write ? '' : 'DRY RUN — '}restaurant SaleItem backfill`);
  console.log(`  closed sessions scanned    ${report.scanned}`);
  console.log(`  sales reconstructed        ${report.reconstructed} (${report.linesWritten} lines)`);
  console.log(`  skipped (items present)    ${report.skippedAlreadyPresent}`);
  console.log(`  DISCREPANT (no rows)       ${report.discrepant.length}`);
  for (const d of report.discrepant) {
    console.log(`    ${d.saleNumber}  Σ lines ${d.sum} != subtotal ${d.subtotal}  (${d.saleId})`);
  }
  if (!write) console.log('\nRe-run with --write to apply.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
