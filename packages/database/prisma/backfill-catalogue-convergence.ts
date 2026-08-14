/**
 * D60 — the catalogue-convergence backfill (convergence plan §12.3.3).
 *
 * Stage A  Product.sellableKind reclassification:
 *            type = 'Service'      → SERVICE
 *            foodType IS NOT NULL  → COMPOSED_ITEM
 *          One new column only; the QuickBooks `type` string is untouched.
 *          (A component-less COMPOSED_ITEM depletes 1:1, so packaged drinks
 *          classified COMPOSED by this rule lose nothing.)
 *
 * Stage B  MenuItem → placements (plan Q2, resolved: auto-create):
 *            linked item    → CatalogueEntry (+ junction copies)
 *            unlinked item  → NEW Product first (scalars copied,
 *                             sellableKind COMPOSED_ITEM), recorded on
 *                             MenuItem.migratedProductId; case-insensitive
 *                             duplicate-name report for the tenant to merge.
 *            priceOverride is written ONLY where basePrice differs from the
 *            product's price, so nothing changes on the day.
 *
 * Stage C  Historical RestaurantOrderItem rows (sourceKind MENU_ITEM,
 *          productId NULL) get productId stamped from the mapping, so one
 *          routing/reporting reference serves every line.
 *
 * Dry-run by default; `--write` applies. Idempotent: existing entries,
 * junction rows and stamped items are skipped. Nothing is ever deleted.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const write = process.argv.includes('--write');
  const report = {
    productsReclassifiedService: 0,
    productsReclassifiedComposed: 0,
    menuItemsScanned: 0,
    productsCreated: 0,
    entriesCreated: 0,
    modifierLinksCopied: 0,
    stationLinksCopied: 0,
    channelPricesCopied: 0,
    availabilityCopied: 0,
    orderItemsStamped: 0,
    possibleDuplicates: [] as string[],
  };

  // ── Stage A ──────────────────────────────────────────────────────────────
  const serviceRows = await prisma.product.findMany({
    where: { type: 'Service', sellableKind: 'STOCK_ITEM' },
    select: { id: true },
  });
  const composedRows = await prisma.product.findMany({
    where: { foodType: { not: null }, type: { not: 'Service' }, sellableKind: 'STOCK_ITEM' },
    select: { id: true },
  });
  report.productsReclassifiedService = serviceRows.length;
  report.productsReclassifiedComposed = composedRows.length;
  if (write) {
    await prisma.product.updateMany({
      where: { id: { in: serviceRows.map((r) => r.id) } },
      data: { sellableKind: 'SERVICE' },
    });
    await prisma.product.updateMany({
      where: { id: { in: composedRows.map((r) => r.id) } },
      data: { sellableKind: 'COMPOSED_ITEM' },
    });
  }

  // ── Stage B ──────────────────────────────────────────────────────────────
  const menuItems = await prisma.menuItem.findMany({
    include: {
      modifierGroups: true,
      stationLinks: true,
      channelPrices: true,
      availability: true,
      section: { select: { id: true } },
    },
  });
  report.menuItemsScanned = menuItems.length;

  for (const mi of menuItems) {
    let productId = mi.productId ?? mi.migratedProductId;

    if (!productId) {
      // Duplicate-name report BEFORE creating, so the operator can merge.
      const dupe = await prisma.product.findFirst({
        where: { tenantId: mi.tenantId, name: { equals: mi.name, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      if (dupe) report.possibleDuplicates.push(`${mi.name} (menuItem ${mi.id} vs product ${dupe.id})`);

      report.productsCreated += 1;
      if (write) {
        const created = await prisma.product.create({
          data: {
            tenantId: mi.tenantId,
            name: mi.name,
            description: mi.description,
            imageUrl: mi.imageUrl,
            unitPrice: mi.basePrice,
            prepMinutes: mi.prepMinutes,
            dietaryTags: mi.dietaryTags,
            foodType: mi.itemType,
            sellableKind: 'COMPOSED_ITEM',
            isActive: mi.isActive,
          },
        });
        productId = created.id;
        await prisma.menuItem.update({
          where: { id: mi.id },
          data: { migratedProductId: created.id },
        });
      } else {
        productId = `(new product for ${mi.name})`;
      }
    }

    // Placement.
    const existingEntry = productId.startsWith('(')
      ? null
      : await prisma.catalogueEntry.findFirst({
          where: { sectionId: mi.sectionId, productId, productVariantId: mi.productVariantId },
          select: { id: true },
        });
    if (!existingEntry) {
      report.entriesCreated += 1;
      if (write) {
        const product = await prisma.product.findUniqueOrThrow({
          where: { id: productId },
          select: { unitPrice: true },
        });
        const entry = await prisma.catalogueEntry.create({
          data: {
            tenantId: mi.tenantId,
            sectionId: mi.sectionId,
            productId,
            productVariantId: mi.productVariantId,
            // Override ONLY where the placement price differed — plan P1.
            priceOverride: product.unitPrice.equals(mi.basePrice) ? null : mi.basePrice,
            position: mi.position,
            isActive: mi.isActive,
          },
        });
        for (const cp of mi.channelPrices) {
          report.channelPricesCopied += 1;
          await prisma.catalogueChannelPrice.create({
            data: { entryId: entry.id, channel: cp.channel, price: cp.price },
          });
        }
        for (const av of mi.availability) {
          report.availabilityCopied += 1;
          await prisma.catalogueAvailability.create({
            data: {
              entryId: entry.id,
              dayOfWeek: av.dayOfWeek,
              startTime: av.startTime,
              endTime: av.endTime,
            },
          });
        }
      } else {
        report.channelPricesCopied += mi.channelPrices.length;
        report.availabilityCopied += mi.availability.length;
      }
    }

    // Junction copies onto the Product (skip rows that already exist).
    if (!productId.startsWith('(')) {
      for (const mg of mi.modifierGroups) {
        const exists = await prisma.productModifierGroup.findFirst({
          where: { productId, modifierGroupId: mg.modifierGroupId },
          select: { id: true },
        });
        if (!exists) {
          report.modifierLinksCopied += 1;
          if (write) {
            await prisma.productModifierGroup.create({
              data: { productId, modifierGroupId: mg.modifierGroupId, position: mg.position },
            });
          }
        }
      }
      for (const sl of mi.stationLinks) {
        const exists = await prisma.productStationLink.findFirst({
          where: { productId, stationId: sl.stationId },
          select: { id: true },
        });
        if (!exists) {
          report.stationLinksCopied += 1;
          if (write) {
            await prisma.productStationLink.create({
              data: { productId, stationId: sl.stationId },
            });
          }
        }
      }
    } else {
      // A to-be-created product's junctions all copy on the write run.
      report.modifierLinksCopied += mi.modifierGroups.length;
      report.stationLinksCopied += mi.stationLinks.length;
    }
  }

  // ── Stage C ──────────────────────────────────────────────────────────────
  const unstamped = await prisma.restaurantOrderItem.findMany({
    where: { sourceKind: 'MENU_ITEM', productId: null },
    select: { id: true, menuItemId: true },
  });
  const mapping = new Map(
    (
      await prisma.menuItem.findMany({
        select: { id: true, productId: true, migratedProductId: true },
      })
    ).map((mi) => [mi.id, mi.productId ?? mi.migratedProductId]),
  );
  for (const item of unstamped) {
    const productId = mapping.get(item.menuItemId);
    if (!productId) continue; // an order line whose menu item was deleted — left as-is
    report.orderItemsStamped += 1;
    if (write) {
      await prisma.restaurantOrderItem.update({
        where: { id: item.id },
        data: { productId },
      });
    }
  }

  console.log(`${write ? '' : 'DRY RUN — '}catalogue convergence backfill`);
  console.log(`  A: products → SERVICE          ${report.productsReclassifiedService}`);
  console.log(`  A: products → COMPOSED_ITEM    ${report.productsReclassifiedComposed}`);
  console.log(`  B: menu items scanned          ${report.menuItemsScanned}`);
  console.log(`  B: products created            ${report.productsCreated}`);
  console.log(`  B: catalogue entries created   ${report.entriesCreated}`);
  console.log(`  B: modifier links copied       ${report.modifierLinksCopied}`);
  console.log(`  B: station links copied        ${report.stationLinksCopied}`);
  console.log(`  B: channel prices copied       ${report.channelPricesCopied}`);
  console.log(`  B: availability rows copied    ${report.availabilityCopied}`);
  console.log(`  C: order items stamped         ${report.orderItemsStamped}`);
  console.log(`  possible duplicates            ${report.possibleDuplicates.length}`);
  for (const d of report.possibleDuplicates) console.log(`    ${d}`);
  if (!write) console.log('\nRe-run with --write to apply.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
