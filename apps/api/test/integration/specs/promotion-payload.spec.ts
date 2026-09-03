/**
 * D102 (4.3) — the till receives enough to PRICE a promotion, not only badge it.
 *
 * ## What was wrong
 *
 * `/products/sellable` sent `{ id, name, type, description }` per product: enough
 * to draw "Buy 2 Get 1" on a tile and nothing to charge for it. A customer could
 * read an offer the till was structurally unable to apply.
 *
 * ## What makes each assertion non-vacuous (D30)
 *
 * The badge case asserts an EXACT key set, not that the badge "still exists". A
 * looser check would pass for a payload that had quietly gained the pricing
 * fields on every product — the duplication 4.3 exists to avoid — or lost
 * `description` while keeping the other three.
 *
 * The eligibility case is a PAIR: an out-of-window promotion must be absent from
 * both places, and an in-window one present in both, in the same response. Either
 * assertion alone passes for a server that returns nothing at all.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;

interface PromotionRulePayload {
  id: string;
  name: string;
  type: string;
  fixedPrice: string | null;
  percentageOff: string | null;
  amountOff: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  stackable: boolean;
  items: { productId: string; role: string; quantity: number }[];
}

interface SellablePayload {
  items: { id: string; promotions: Record<string, unknown>[] }[];
  promotionRules?: PromotionRulePayload[];
}

const ownerToken = () =>
  http.tokenFor({
    userId: tile.ownerId,
    tenantId: tile.tenantId,
    role: 'OWNER',
    activeBranchId: tile.branchId,
  });

const fetchSellable = async () => {
  const res = await http.request<SellablePayload>(
    'GET',
    `/products/sellable?branchId=${tile.branchId}&channel=COUNTER`,
    { token: ownerToken() },
  );
  expect(res.status).toBe(200);
  return res.data;
};

beforeAll(async () => {
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  /*
   * Leave no global state behind — the lesson 3.16 recorded. This file creates
   * promotions against the deterministic fixture id `tile-tenant`, and a later
   * suite booting its app before its own `resetDatabase` would hydrate whatever
   * is left here.
   */
  await resetDatabase(prisma);
  await http.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await linkUsersToRoles(prisma, tile.tenantId);
});

/** A promotion naming product A, live unless `endsOn` puts it in the past. */
async function seedPromotion(over: Record<string, unknown> = {}) {
  return prisma.promotion.create({
    data: {
      tenantId: tile.tenantId,
      name: (over.name as string) ?? 'Two for the price of one',
      type: 'BUNDLE_FIXED_PRICE',
      fixedPrice: '1500.00',
      stackable: false,
      isActive: true,
      items: {
        create: [{ productId: tile.productAId, role: 'BUNDLE', quantity: 2 }],
      },
      ...over,
    },
  });
}

describe('4.3 — the sellable payload can be priced, not only badged', () => {
  it('returns the promotion in a shape the applier can consume', async () => {
    const promo = await seedPromotion();

    const payload = await fetchSellable();
    const rule = payload.promotionRules?.find((r) => r.id === promo.id);

    // POSITIVE: it is there, with the fields the applier reads.
    expect(rule).toBeDefined();
    expect(rule!.type).toBe('BUNDLE_FIXED_PRICE');
    expect(rule!.stackable).toBe(false);
    expect(rule!.items).toEqual([
      { productId: tile.productAId, role: 'BUNDLE', quantity: 2 },
    ]);

    /*
     * Decimals arrive as STRINGS, like `unitPrice` and `availableQuantity`
     * everywhere else in this payload — a JSON number cannot carry a Decimal
     * safely. `catalog.ts` converts once, on the way into the applier.
     */
    expect(typeof rule!.fixedPrice).toBe('string');
    expect(Number(rule!.fixedPrice)).toBe(1500);
    // NEGATIVE: the fields this type does not use are null, not zero — zero is a
    // real percentage and must stay distinguishable from "not set".
    expect(rule!.percentageOff).toBeNull();
    expect(rule!.amountOff).toBeNull();
  });

  it('sends each rule ONCE, not copied onto every participating product', async () => {
    await seedPromotion();

    const payload = await fetchSellable();

    // The rules live at the response level…
    expect(payload.promotionRules).toHaveLength(1);
    // …and the per-product entry is still only a badge. Copying the rule onto
    // each product would repeat a bundle's whole definition per member.
    const badged = payload.items.filter((i) => i.promotions.length > 0);
    expect(badged.length).toBeGreaterThan(0);
    for (const item of badged) {
      for (const badge of item.promotions) {
        expect(Object.keys(badge).sort()).toEqual(['description', 'id', 'name', 'type']);
      }
    }
  });

  it('the badge keeps EXACTLY its previous shape — zero breakage', async () => {
    const promo = await seedPromotion();

    const payload = await fetchSellable();
    const withBadge = payload.items.find((i) => i.promotions.length > 0);

    expect(withBadge).toBeDefined();
    // An exact key set, not a superset check: gaining a pricing field here is
    // the duplication 4.3 avoids, and losing `description` is a regression.
    expect(Object.keys(withBadge!.promotions[0]!).sort()).toEqual([
      'description',
      'id',
      'name',
      'type',
    ]);
    expect(withBadge!.promotions[0]!.id).toBe(promo.id);
  });

  it('badge and rules share ONE eligibility pass', async () => {
    const live = await seedPromotion({ name: 'Live offer' });
    const expired = await seedPromotion({
      name: 'Finished offer',
      endsOn: new Date('2020-01-01T00:00:00.000Z'),
    });

    const payload = await fetchSellable();
    const ruleIds = (payload.promotionRules ?? []).map((r) => r.id);
    const badgeIds = payload.items.flatMap((i) => i.promotions.map((p) => p.id as string));

    // POSITIVE: the live one is in both places…
    expect(ruleIds).toContain(live.id);
    expect(badgeIds).toContain(live.id);
    // NEGATIVE: …and the finished one in neither. Two eligibility passes is how
    // a badge and a price come to disagree about what is on offer.
    expect(ruleIds).not.toContain(expired.id);
    expect(badgeIds).not.toContain(expired.id);
  });

  it('a tenant with no promotions gets an empty list, not a missing field', async () => {
    const payload = await fetchSellable();

    // The client maps over this; `undefined` would be an optional-chain away
    // from a runtime error on the busiest screen in the app.
    expect(payload.promotionRules).toEqual([]);
  });
});
