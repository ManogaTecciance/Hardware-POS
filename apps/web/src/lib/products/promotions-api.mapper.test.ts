/**
 * The wire mapper must not drop fields the editor depends on.
 *
 * ## The defect this exists for
 *
 * 4.10 taught four layers to carry a promotion item's product name so the edit
 * screen would stop rendering a raw cuid: the repository joined it, the service
 * flattened it to `productName`, the client type declared it, and the editor
 * read it. The transport mapper in between was missed:
 *
 *     interface ApiPromotionItem { id; productId; role; quantity }   // no name
 *     function toItem(i) { return { id, productId, role, quantity } } // dropped
 *
 * Nothing failed, because `productName?:` is OPTIONAL on `PromotionItem` — an
 * object without it is a perfectly valid `PromotionItem`, so the compiler had
 * no reason to object. The server sent the name on every response and the
 * mapper threw it away; the editor fell back to `i.productId` and the operator
 * saw `cmtldj0ta0003q4bs27ibki2q` where "Shirt" belonged.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The name is asserted POSITIVELY (it survives the mapper) and the fallback
 * NEGATIVELY (nothing cuid-shaped reaches the editor). Either alone would pass
 * for the broken mapper: the positive one would fail, but a test that only
 * checked "no cuid appears" would also pass for a mapper that returned nothing
 * at all.
 *
 * The three distinct server answers are separated, because they mean different
 * things and the editor renders them differently: a name, an explicit `null`
 * (the product was deleted — fall back to the id, honestly), and an absent
 * field (a response predating the join).
 *
 * Mutation proof is recorded at the end of this file.
 */
import { describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authorizedFetch: vi.fn(),
}));

const { fetchPromotion } = await import('./promotions-api');

const session = {
  token: 'tok',
  user: { id: 'u1', tenantId: 't1', role: 'OWNER', permissions: [] },
} as never;

/** A server response in the shape `promotions.service.ts#toView` produces. */
function apiPromotion(items: Record<string, unknown>[]) {
  return {
    id: 'promo_1',
    tenantId: 't1',
    name: 'Buy 2 Get 1 Free',
    description: 'KOKO',
    type: 'BUY_X_GET_Y',
    fixedPrice: null,
    percentageOff: '100',
    amountOff: null,
    buyQuantity: 2,
    getQuantity: 1,
    startsOn: null,
    endsOn: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    branchScope: [],
    channelScope: ['COUNTER'],
    stackable: false,
    isActive: true,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    items,
  };
}

/** What the operator must never see in the Products list of the editor. */
const CUID = /^c[a-z0-9]{20,}$/;

describe('fetchPromotion carries the joined product name through to the editor', () => {
  it('keeps productName when the server sends one', async () => {
    get.mockResolvedValueOnce(
      apiPromotion([
        {
          id: 'pi_1',
          productId: 'cmtldj0ta0003q4bs27ibki2q',
          productName: 'Shirt',
          role: 'BUY',
          quantity: 2,
        },
        {
          id: 'pi_2',
          productId: 'cmtldp7ou001xq4bspmox6j3h',
          productName: 'Tie',
          role: 'GET',
          quantity: 1,
        },
      ]),
    );

    const promo = await fetchPromotion(session, 'promo_1');

    // POSITIVE: the exact set of names, in order — not a count, and not "some
    // name is present", either of which would pass for a mapper that copied the
    // first item's name onto both rows.
    expect(promo.items.map((i) => i.productName)).toEqual(['Shirt', 'Tie']);

    // NEGATIVE: this is what the screen actually showed. The editor renders
    // `i.name ?? i.productId`, so a dropped name is invisible in the type system
    // and visible only as a cuid on screen.
    for (const item of promo.items) {
      expect(item.productName).not.toMatch(CUID);
      expect(item.productName).toBeTruthy();
    }

    // The rest of the item survives unchanged — a mapper "fixed" by returning
    // the raw wire object would pass the two assertions above while quietly
    // handing the editor a string quantity.
    expect(promo.items[0]!).toMatchObject({
      id: 'pi_1',
      productId: 'cmtldj0ta0003q4bs27ibki2q',
      role: 'BUY',
      quantity: 2,
    });
    expect(typeof promo.items[0]!.quantity).toBe('number');
  });

  it('preserves an explicit null — the product was deleted', async () => {
    get.mockResolvedValueOnce(
      apiPromotion([
        { id: 'pi_1', productId: 'cmtldj0ta0003q4bs27ibki2q', productName: null, role: 'BUY', quantity: 1 },
      ]),
    );

    const promo = await fetchPromotion(session, 'promo_1');

    // Null must arrive as null, not as undefined and not as the id: the editor
    // falls back to the cuid deliberately here, because there is no name left
    // to show and inventing one would be worse.
    expect(promo.items[0]!.productName).toBeNull();
  });

  it('tolerates a response that predates the join', async () => {
    get.mockResolvedValueOnce(
      apiPromotion([
        { id: 'pi_1', productId: 'cmtldj0ta0003q4bs27ibki2q', role: 'BUY', quantity: 1 },
      ]),
    );

    const promo = await fetchPromotion(session, 'promo_1');

    expect(promo.items[0]!.productName).toBeUndefined();
    // and the item is otherwise intact rather than throwing on the missing key.
    expect(promo.items[0]!.productId).toBe('cmtldj0ta0003q4bs27ibki2q');
  });
});

/*
 * MUTATION PROOF (D30 §5) — run against the defect as it actually shipped.
 *
 * Removing `productName: i.productName,` from `toItem` in promotions-api.ts,
 * which is verbatim the state this bug was reported in:
 *
 *   ✗ keeps productName when the server sends one
 *       expected [ undefined, undefined ] to equal [ 'Shirt', 'Tie' ]
 *   ✗ preserves an explicit null — the product was deleted
 *       expected undefined to be null
 *   ✓ tolerates a response that predates the join   (correctly still passes —
 *     absent in, absent out is the same observable result either way)
 *
 * Two of three fail on the real defect, and the one that passes is the case
 * where the broken and the fixed mapper genuinely agree. The suite is not
 * vacuous.
 */
