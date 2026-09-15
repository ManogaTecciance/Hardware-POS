/**
 * D198 — the buy-X-get-Y prompt on the restaurant POS.
 *
 * The PO's case: "Buy 1 Plain Tea, get 1 Garden Salad free". Adding the tea
 * used to show nothing — the salad went free only if the cashier happened to
 * add it — and the question "is that the correct behaviour?" settled on the
 * industry's answer: the free item must be ON the order to be free, the guest
 * must be OFFERED it, and the guest may say no. So the till asks, waits for
 * an answer, and takes either.
 *
 * ## Why these claims
 *
 *   - the gate is asserted as a PAIR with the card: a disabled button alone is
 *     also what a permission miss produces, and a card alone is what a gate
 *     that stopped gating produces;
 *   - both answers are asserted to open the gate, and to differ in the one
 *     thing they should — Add prices the salad to zero, declined prices
 *     nothing — because an Add that only cleared the card would look identical
 *     until the guest paid for the salad;
 *   - a decline is asserted to hold for THAT ask and to yield to the next,
 *     since "declined once" that silenced every later ask would hide a second
 *     salad the order earned;
 *   - dine-in is asserted over the table's SENT rounds with an empty draft,
 *     because a prompt that only read the draft would pass every counter case
 *     and still ask a waiter for a salad the table already has.
 *
 * Mutation-proven, each run against the component itself:
 *   1. `&& !awaitingOffer` dropped from `canPlace` — every case that reads
 *      the gate closed fails (4 failed, 7 passed);
 *   2. dine-in reads the draft only (`sentLinesForOffers` dropped) — "counts
 *      the tea the kitchen already has" and "subtracts the salad the table
 *      already holds" fail, 9 pass. The "asks nothing" control passes under
 *      this mutation on its own — which is why the subtraction case pins an
 *      exact count rather than an absence;
 *   3. `declined` ignored in `pendingOffers` — every decline case fails, on
 *      both tills (5 failed, 6 passed);
 *   4. the by-id fetch dropped — "fetches a reward the catalogue page did not
 *      carry" fails alone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { PromotionRule } from '@hardware-pos/shared';
import type { PosCatalogueItem } from '@/lib/restaurant/pos-catalogue-api';
import type {
  DiningAreaView,
  RestaurantTableView,
  SessionDetail,
  TableSessionView,
} from '@/lib/restaurant/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

const TEA = 'prd_tea';
const SALAD = 'prd_salad';
const KOTTU = 'prd_kottu';
const RICE = 'prd_rice';

function catalogueItem(id: string, name: string, unitPrice: number): PosCatalogueItem {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    unitPrice,
    prepMinutes: null,
    dietaryTags: [],
    foodType: 'FOOD',
    category: null,
    subcategory: null,
    // No modifiers and no variants: a tap (and the card's Add) goes straight
    // into the cart, so the spec never has to drive the Customise dialog.
    hasVariants: false,
    variants: [],
    modifierGroups: [],
    stations: [],
    promotions: [],
    stockState: 'UNTRACKED',
  };
}

const TEA_ITEM = catalogueItem(TEA, 'Plain Tea', 150);
const SALAD_ITEM = catalogueItem(SALAD, 'Garden Salad', 400);
const KOTTU_ITEM = catalogueItem(KOTTU, 'Kottu', 900);
const RICE_ITEM = catalogueItem(RICE, 'Rice and Curry', 650);

const { catalogueToMenuData } = await vi.importActual<typeof import('./use-menu-data')>(
  './use-menu-data',
);
const FULL_MENU = catalogueToMenuData([TEA_ITEM, SALAD_ITEM, KOTTU_ITEM, RICE_ITEM]);
/** The page the till happens to have loaded does not carry the salad. */
const MENU_WITHOUT_SALAD = catalogueToMenuData([TEA_ITEM, KOTTU_ITEM, RICE_ITEM]);

/** Buy 1 Plain Tea, get 1 Garden Salad free — the PO's own example. */
const TEA_SALAD: PromotionRule = {
  id: 'promo_tea',
  name: 'Free salad with tea',
  type: 'BUY_X_GET_Y',
  fixedPrice: null,
  percentageOff: 100,
  amountOff: null,
  buyQuantity: 1,
  getQuantity: 1,
  stackable: true,
  minimumSpend: null,
  items: [
    { productId: TEA, role: 'BUY', quantity: 1 },
    { productId: SALAD, role: 'GET', quantity: 1 },
  ],
};
/** Buy 2 Kottu get 1 free — the same-product shape. */
const KOTTU_B2G1: PromotionRule = {
  id: 'promo_kottu',
  name: 'Kottu Tuesday',
  type: 'BUY_X_GET_Y',
  fixedPrice: null,
  percentageOff: 100,
  amountOff: null,
  buyQuantity: 2,
  getQuantity: 1,
  stackable: true,
  minimumSpend: null,
  items: [
    { productId: KOTTU, role: 'BUY', quantity: 1 },
    { productId: KOTTU, role: 'GET', quantity: 1 },
  ],
};

const AREA = { id: 'area_1', branchId: 'brn_1', name: 'Terrace', position: 0, isActive: true } as DiningAreaView;
const TABLE = {
  id: 'tbl_1',
  areaId: 'area_1',
  code: 'T1',
  label: 'Table 1',
  capacity: 4,
  status: 'OCCUPIED',
} as RestaurantTableView;
const OPEN_ROW = {
  id: 'ses_1',
  sessionNumber: 'TS-000042',
  tableId: 'tbl_1',
  branchId: 'brn_1',
  status: 'OPEN',
  openedAt: '2026-09-15T10:00:00.000Z',
  guestCount: 2,
  tabName: null,
  activeOrderId: 'ord_1',
  readyTicketIds: [],
} as unknown as TableSessionView;

function sentItem(id: string, productId: string, unitPrice: number) {
  return {
    id,
    menuItemId: productId,
    productId,
    menuItemName: productId,
    variantName: null,
    unitPrice: unitPrice.toFixed(2),
    modifierTotal: '0.00',
    quantity: '1.000',
    specialInstructions: null,
    status: 'SENT',
    modifiers: [],
  };
}

/** A table with one round already at the kitchen. */
function detailWith(items: ReturnType<typeof sentItem>[]): SessionDetail {
  return {
    session: OPEN_ROW,
    orders: [
      {
        order: { id: 'ord_1', orderNumber: 'ORD-1', status: 'OPEN' },
        rounds: [{ round: { id: 'rnd_1', roundNumber: 1, status: 'SUBMITTED' }, items }],
      },
    ],
  } as unknown as SessionDetail;
}

// ── mocks ────────────────────────────────────────────────────────────────────

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn(), push }) }));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const session = {
  token: 't',
  branchName: 'Main',
  user: { id: 'usr_1', tenantId: 'tnt_1', role: 'OWNER' as const, permissions: [] },
} as never;

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session, hasPermission: () => true }),
}));

vi.mock('@/lib/platform-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-profile')>()),
  useEffectiveProfile: () => ({
    profile: { capabilities: { fulfilment: { kind: 'TABLE_SERVICE' } } },
    loading: false,
    error: null,
  }),
}));

const getDetail = vi.fn<() => Promise<SessionDetail>>();
vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: { get: () => Promise.resolve({ serviceChargePercent: 0 }) },
  diningAreas: { list: () => Promise.resolve([AREA]) },
  restaurantTables: { list: () => Promise.resolve([TABLE]) },
  openTables: { list: () => Promise.resolve([]) },
  tableSessions: {
    listOpen: () => Promise.resolve([OPEN_ROW]),
    get: () => Promise.resolve(OPEN_ROW),
    getDetail: () => getDetail(),
    createOrder: vi.fn(),
    submitRound: vi.fn(),
    voidItem: vi.fn(),
    close: vi.fn(),
    billPreview: vi.fn(),
    open: vi.fn(),
  },
  takeaway: { create: vi.fn(), settle: vi.fn(), updateStatus: vi.fn() },
}));

/** The by-id lookup for a reward the loaded page did not carry. */
const fetchPosCatalogue = vi.fn();
vi.mock('@/lib/restaurant/pos-catalogue-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/pos-catalogue-api')>()),
  fetchPosCatalogue: (...args: unknown[]) => fetchPosCatalogue(...args),
}));

/** Swapped per test: the page the till has loaded. */
let menu = FULL_MENU;
vi.mock('./use-menu-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-menu-data')>()),
  useMenuData: () => ({ data: menu, loading: false, error: null, reload: vi.fn() }),
  usePosCatalogue: () => ({
    data: menu,
    loading: false,
    error: null,
    reload: vi.fn(),
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    total: 4,
    loadedCount: 4,
    promotionRules: [TEA_SALAD, KOTTU_B2G1],
  }),
}));

const { PosCounterWorkspace } = await import('./pos-counter-workspace');

// ── harness ──────────────────────────────────────────────────────────────────

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountTakeaway() {
  render(
    <ConfirmProvider>
      <PosCounterWorkspace
        session={session}
        branchId="brn_1"
        initialMode="TAKEAWAY"
        onModeChange={vi.fn()}
      />
    </ConfirmProvider>,
  );
  await settle();
}

async function mountDineIn() {
  render(
    <ConfirmProvider>
      <PosCounterWorkspace
        session={session}
        branchId="brn_1"
        initialMode="DINE_IN"
        linkedSessionId="ses_1"
        onModeChange={vi.fn()}
      />
    </ConfirmProvider>,
  );
  await settle();
}

const tapMenu = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));
/** Cart lines, counted by the control that exists only on a cart line. */
const cartLines = () => screen.queryAllByRole('button', { name: 'Remove item' });
const offersRegion = () => screen.queryByRole('region', { name: 'Offers to answer' });
const offerCard = (promotionName: string) =>
  within(screen.getByRole('region', { name: 'Offers to answer' })).getByRole('group', {
    name: promotionName,
  });
const placeOrder = () => screen.getByRole('button', { name: /Place Order/ }) as HTMLButtonElement;
const sendRound = () => screen.getByRole('button', { name: /Confirm & send/ }) as HTMLButtonElement;

beforeEach(() => {
  menu = FULL_MENU;
  getDetail.mockResolvedValue(detailWith([]));
  fetchPosCatalogue.mockResolvedValue({ items: [], total: 0, nextCursor: null, promotionRules: [] });
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── counter / takeaway ───────────────────────────────────────────────────────

describe('the buy-X-get-Y prompt at the counter (D198)', () => {
  it('asks for the salad the tea earned, and holds the order until answered', async () => {
    await mountTakeaway();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(cartLines()).toHaveLength(1));

    // POSITIVE — the card names the offer and the reward, with its count.
    const card = offerCard('Free salad with tea');
    expect(within(card).getByText(/1 × Garden Salad/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Customer declined' })).toBeTruthy();
    // …and the gate is closed, with the reason stated where the button is.
    expect(placeOrder().disabled).toBe(true);
    expect(screen.getByText('Answer the offer above to continue.')).toBeTruthy();
  });

  it('Add puts the salad in the order at nothing, and opens the gate', async () => {
    await mountTakeaway();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());

    fireEvent.click(within(offerCard('Free salad with tea')).getByRole('button', { name: 'Add' }));

    // The salad is a real line — the kitchen makes it, the receipt shows it…
    await waitFor(() => expect(cartLines()).toHaveLength(2));
    // …priced by the promotion, not by the guest.
    expect(screen.getByText('Promotion: Free salad with tea')).toBeTruthy();
    // NEGATIVE — nothing left to ask, nothing left to hold.
    expect(offersRegion()).toBeNull();
    expect(placeOrder().disabled).toBe(false);
  });

  it('Customer declined opens the gate and prices nothing', async () => {
    await mountTakeaway();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());

    fireEvent.click(
      within(offerCard('Free salad with tea')).getByRole('button', { name: 'Customer declined' }),
    );

    await waitFor(() => expect(offersRegion()).toBeNull());
    expect(placeOrder().disabled).toBe(false);
    // NEGATIVE — the tea alone earns no discount, and the cart is still the tea.
    expect(cartLines()).toHaveLength(1);
    expect(screen.queryByText(/^Promotion/)).toBeNull();
  });

  it('a decline holds for that ask, and a second tea asks again', async () => {
    await mountTakeaway();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());
    fireEvent.click(
      within(offerCard('Free salad with tea')).getByRole('button', { name: 'Customer declined' }),
    );
    await waitFor(() => expect(offersRegion()).toBeNull());

    // Same tea, re-rendered by an unrelated add: still declined.
    tapMenu(/Rice and Curry/);
    await waitFor(() => expect(cartLines()).toHaveLength(2));
    expect(offersRegion()).toBeNull();

    // A second tea earns a second salad — a new question, asked with its count.
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());
    expect(within(offerCard('Free salad with tea')).getByText(/2 × Garden Salad/)).toBeTruthy();
    expect(placeOrder().disabled).toBe(true);
  });

  it('reads a same-product offer the same way — one more kottu is free', async () => {
    await mountTakeaway();
    tapMenu(/Kottu/);
    await waitFor(() => expect(cartLines()).toHaveLength(1));
    // Control: one kottu has qualified for nothing, so nothing is asked.
    expect(offersRegion()).toBeNull();
    expect(placeOrder().disabled).toBe(false);

    tapMenu(/Kottu/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());
    const card = offerCard('Kottu Tuesday');
    expect(within(card).getByText(/1 × Kottu/)).toBeTruthy();
    expect(placeOrder().disabled).toBe(true);

    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    // The third kottu merges onto the same line, and the group prices.
    await waitFor(() => expect(screen.getByText('Promotion: Kottu Tuesday')).toBeTruthy());
    expect(cartLines()).toHaveLength(1);
    expect(offersRegion()).toBeNull();
    expect(placeOrder().disabled).toBe(false);
  });

  it('fetches a reward the catalogue page did not carry, by id, and can add it', async () => {
    menu = MENU_WITHOUT_SALAD;
    fetchPosCatalogue.mockResolvedValue({
      items: [SALAD_ITEM],
      total: 1,
      nextCursor: null,
      promotionRules: [],
    });
    await mountTakeaway();
    tapMenu(/Plain Tea/);

    // POSITIVE — one lookup, for exactly the missing product, on this channel.
    await waitFor(() => expect(fetchPosCatalogue).toHaveBeenCalledTimes(1));
    expect(fetchPosCatalogue.mock.calls[0]![1]).toMatchObject({
      branchId: 'brn_1',
      channel: 'TAKEAWAY',
      productId: [SALAD],
    });
    // The card names it once the lookup lands, and Add works off the fetched row.
    const card = offerCard('Free salad with tea');
    await waitFor(() => expect(within(card).getByText(/1 × Garden Salad/)).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(cartLines()).toHaveLength(2));
    expect(screen.getByText('Promotion: Free salad with tea')).toBeTruthy();
  });

  it('a new order after completion has answered nothing yet', async () => {
    // The decline belongs to the ORDER: `newOrder` clears it. Exercised through
    // the mode reset, which is the reset path reachable without a payment.
    await mountTakeaway();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());
    fireEvent.click(
      within(offerCard('Free salad with tea')).getByRole('button', { name: 'Customer declined' }),
    );
    await waitFor(() => expect(offersRegion()).toBeNull());

    // Change order type → confirm → the cart and its answers are gone.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change order type' }));
    expect(await screen.findByRole('dialog', { name: 'Start new order' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Takeaway/ }));
    await settle();
    tapMenu(/Plain Tea/);
    await waitFor(() => expect(offersRegion()).not.toBeNull());
  });
});

// ── dine-in ──────────────────────────────────────────────────────────────────

describe('the buy-X-get-Y prompt for the waiter (D198)', () => {
  it('counts the tea the kitchen already has, and holds the next round', async () => {
    getDetail.mockResolvedValue(detailWith([sentItem('itm_tea', TEA, 150)]));
    await mountDineIn();

    // POSITIVE — an EMPTY draft, and the table's own tea asks for its salad.
    await waitFor(() => expect(offersRegion()).not.toBeNull());
    expect(within(offerCard('Free salad with tea')).getByText(/1 × Garden Salad/)).toBeTruthy();

    // Something unrelated in the round: Confirm & send is held by the offer,
    // and says so — not by the role, which can send.
    tapMenu(/Rice and Curry/);
    await waitFor(() => expect(cartLines()).toHaveLength(1));
    expect(sendRound().disabled).toBe(true);
    expect(screen.getByText('Answer the offer above to continue.')).toBeTruthy();
    expect(screen.queryByText(/Your role can build a draft/)).toBeNull();

    fireEvent.click(
      within(offerCard('Free salad with tea')).getByRole('button', { name: 'Customer declined' }),
    );
    await waitFor(() => expect(sendRound().disabled).toBe(false));
    // The table remembers the answer between rounds, on this device.
    expect(JSON.parse(window.sessionStorage.getItem('hpos.pos.offerDeclines.ses_1')!)).toEqual([
      'promo_tea:1',
    ]);
  });

  it('subtracts the salad the table already holds from an earlier round', async () => {
    /*
     * Two teas and one salad already at the kitchen: ONE more salad is owed,
     * not two and not none. Pinned as the exact count because each wrong
     * reading has a silent twin — "none" is what ignoring the sent rounds
     * produces, "two" what counting the teas but not the salad produces.
     */
    getDetail.mockResolvedValue(
      detailWith([
        sentItem('itm_tea1', TEA, 150),
        sentItem('itm_tea2', TEA, 150),
        sentItem('itm_salad', SALAD, 400),
      ]),
    );
    await mountDineIn();

    await waitFor(() => expect(offersRegion()).not.toBeNull());
    expect(within(offerCard('Free salad with tea')).getByText(/1 × Garden Salad/)).toBeTruthy();
  });

  it('asks nothing when the table already holds every salad it earned', async () => {
    getDetail.mockResolvedValue(
      detailWith([sentItem('itm_tea', TEA, 150), sentItem('itm_salad', SALAD, 400)]),
    );
    await mountDineIn();
    tapMenu(/Rice and Curry/);
    await waitFor(() => expect(cartLines()).toHaveLength(1));

    // NEGATIVE control — tea in round one, salad in round one: nothing to ask.
    expect(offersRegion()).toBeNull();
    expect(sendRound().disabled).toBe(false);
  });

  it('a decline stored for the table is honoured when it is picked up again', async () => {
    window.sessionStorage.setItem('hpos.pos.offerDeclines.ses_1', JSON.stringify(['promo_tea:1']));
    getDetail.mockResolvedValue(detailWith([sentItem('itm_tea', TEA, 150)]));
    await mountDineIn();
    tapMenu(/Rice and Curry/);
    await waitFor(() => expect(cartLines()).toHaveLength(1));

    expect(offersRegion()).toBeNull();
    expect(sendRound().disabled).toBe(false);
  });
});
