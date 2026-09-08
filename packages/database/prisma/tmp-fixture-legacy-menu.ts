import { Prisma, PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'restaurant-demo' } });
  const branch = await prisma.branch.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const station = await prisma.kitchenStation.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const group = await prisma.modifierGroup.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Fixture Extras' } },
    update: {},
    create: {
      tenantId: tenant.id, name: 'Fixture Extras',
      options: { create: [{ tenantId: tenant.id, name: 'Extra cheese', priceDelta: new Prisma.Decimal('150.00') }] },
    },
  });
  const linkedProduct = await prisma.product.findFirstOrThrow({
    where: { tenantId: tenant.id, foodType: 'FOOD' },
  });

  const menu = await prisma.menu.upsert({
    where: { branchId_name: { branchId: branch.id, name: 'Legacy Fixture Menu' } },
    update: {}, create: { tenantId: tenant.id, branchId: branch.id, name: 'Legacy Fixture Menu' },
  });
  const section = await prisma.menuSection.upsert({
    where: { menuId_name: { menuId: menu.id, name: 'Legacy Mains' } },
    update: {}, create: { tenantId: tenant.id, menuId: menu.id, name: 'Legacy Mains' },
  });
  // Linked item at a DIFFERENT price than the product → priceOverride expected.
  const linkedExisting = await prisma.menuItem.findFirst({ where: { sectionId: section.id, name: 'Legacy Linked Dish' } });
  const linked = linkedExisting ?? await prisma.menuItem.create({
    data: {
      tenantId: tenant.id, sectionId: section.id, name: 'Legacy Linked Dish',
      basePrice: linkedProduct.unitPrice.plus(new Prisma.Decimal('100.00')),
      productId: linkedProduct.id,
      stationLinks: { create: [{ stationId: station.id }] },
      modifierGroups: { create: [{ modifierGroupId: group.id }] },
    },
  });
  // Unlinked composed dish → product auto-created.
  const unlinkedExisting = await prisma.menuItem.findFirst({ where: { sectionId: section.id, name: 'Legacy House Special' } });
  const unlinked = unlinkedExisting ?? await prisma.menuItem.create({
    data: {
      tenantId: tenant.id, sectionId: section.id, name: 'Legacy House Special',
      basePrice: new Prisma.Decimal('1234.00'), itemType: 'FOOD',
      dietaryTags: ['Spicy'], prepMinutes: 25,
      stationLinks: { create: [{ stationId: station.id }] },
    },
  });
  // A historical unstamped order line pointing at the linked item.
  const order = await prisma.restaurantOrder.findFirstOrThrow({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
  });
  const round = await prisma.orderRound.findFirstOrThrow({ where: { orderId: order.id } });
  await prisma.restaurantOrderItem.create({
    data: {
      tenantId: tenant.id, orderId: order.id, roundId: round.id,
      menuItemId: linked.id, menuItemName: linked.name, unitPrice: linked.basePrice,
      quantity: new Prisma.Decimal(1), status: 'DELIVERED', sourceKind: 'MENU_ITEM',
    },
  });
  console.log('fixture ready:', { linked: linked.id, unlinked: unlinked.id });
}
main().finally(() => prisma.$disconnect());
