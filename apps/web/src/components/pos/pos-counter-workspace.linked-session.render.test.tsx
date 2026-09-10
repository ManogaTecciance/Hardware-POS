/**
 * D155 — the POS opened on a table the floor already chose.
 *
 * ## Why these claims
 *
 * "View order" on the floor plan used to open a screen of its own. It now opens
 * THIS workspace with `?sessionId=`, and the whole value of that is the absence
 * of a second question: the waiter tapped table nine, so the POS must be on
 * table nine's order with the menu in front of them, not on "Which table?".
 *
 * Every claim below is therefore asserted against its opposite on the same
 * component, because each failure is silent in both directions:
 *
 *   - an ignored `sessionId` looks exactly like an ordinary POS visit, which is
 *     how the page came to read only `?mode=` while the orders queue was already
 *     composing this URL (that button is disabled for its own reason, E18), so
 *     the picker's absence is asserted WITH the strip that replaced it, and both
 *     against a link-less mount that must still show the picker;
 *   - a send gated on a table the link already supplied would look like a dead
 *     button, so Confirm & send is asserted armed here and refused without the
 *     link;
 *   - a table label resolved from the wrong read degrades to a session number
 *     ("TS-000042"), which is not obviously wrong on screen — so the NAME is
 *     asserted, in the header and on the strip.
 *
 * Mutation-proven, each mutation run against the components themselves:
 *   1. never adopting the id (the `setLinkedSessionId` in the take effect
 *      removed, so `?sessionId=` is read and dropped — the live bug's shape)
 *      — 5 failed, 1 passed: every bound claim, and the link-less negative
 *      stays green, which is what proves the two mounts are distinguishable;
 *   2. `locked={false}` on the panel — 1 failed, 5 passed: exactly the picker
 *      case, so the lock and the binding are separable claims and not one
 *      assertion written twice;
 *   3. `activeSessionFrom` losing the label map (falling back to the session
 *      number, which is what a resolver reading `GET /table-sessions/:id`
 *      would have) — 3 failed, 3 passed, the name among them;
 *   4. `flattenSubmittedRounds` counting DRAFT rounds too — 1 failed, 5
 *      passed: the strip reads "3 rounds sent" for a table that has two.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { PosCatalogueItem } from '@/lib/restaurant/pos-catalogue-api';
import type {
  DiningAreaView,
  RestaurantTableView,
  SessionDetail,
  TableSessionView,
} from '@/lib/restaurant/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

function catalogueItem(id: string, name: string): PosCatalogueItem {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    unitPrice: 250,
    prepMinutes: null,
    dietaryTags: [],
    foodType: 'FOOD',
    category: null,
    subcategory: null,
    hasVariants: false,
    variants: [],
    modifierGroups: [],
    stations: [],
    promotions: [],
    stockState: 'UNTRACKED',
  };
}

/** Built through the REAL adapter, so the grid cannot render rows production never makes. */
const { catalogueToMenuData } = await vi.importActual<typeof import('./use-menu-data')>(
  './use-menu-data',
);
const MENU = catalogueToMenuData([catalogueItem('p1', 'Rice and Curry')]);

const AREA = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Terrace',
  position: 0,
  isActive: true,
} as DiningAreaView;

/** `label` differs from `code` on purpose: the label is what the waiter reads. */
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
  openedAt: '2026-09-10T10:00:00.000Z',
  guestCount: 4,
  tabName: null,
  activeOrderId: 'ord_1',
  readyTicketIds: [],
} as unknown as TableSessionView;

/**
 * Two SUBMITTED rounds and one DRAFT. The draft is the fixture's job: the strip
 * must read "2 rounds sent", and a count that simply counted rounds would say
 * three.
 */
const DETAIL = {
  session: OPEN_ROW,
  orders: [
    {
      order: { id: 'ord_1', orderNumber: 'ORD-1', status: 'OPEN' },
      rounds: [
        { round: { id: 'rnd_1', roundNumber: 1, status: 'READY' }, items: [] },
        { round: { id: 'rnd_2', roundNumber: 2, status: 'SUBMITTED' }, items: [] },
        { round: { id: 'rnd_3', roundNumber: 3, status: 'DRAFT' }, items: [] },
      ],
    },
  ],
} as unknown as SessionDetail;

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
  user: { id: 'usr_1', tenantId: 'tnt_1', role: 'OWNER' as const },
} as never;

vi.mock('@/lib/auth', () => ({
  // Every mode, so the mode chip would render — which is what lets the "no
  // Change chip while bound to a table" assertion mean something.
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

const listOpen = vi.fn<() => Promise<TableSessionView[]>>();
const getSession = vi.fn<() => Promise<TableSessionView>>();
const getDetail = vi.fn<() => Promise<SessionDetail>>();

/*
 * The whole restaurant API is stubbed here, unlike the sibling spec, because
 * the resolver under test (`lib/restaurant/active-session.ts`) reads FOUR
 * endpoints to answer "what is this table called" — and it swallows each
 * failure, so a missing stub would not throw: it would quietly produce a
 * session number where the label should be, and the labels asserted below are
 * what catch that.
 */
vi.mock('@/lib/restaurant/api', () => ({
  restaurantConfig: { get: () => Promise.resolve({ serviceChargePercent: 0 }) },
  diningAreas: { list: () => Promise.resolve([AREA]) },
  restaurantTables: { list: () => Promise.resolve([TABLE]) },
  openTables: { list: () => Promise.resolve([]) },
  tableSessions: {
    listOpen: () => listOpen(),
    get: () => getSession(),
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

vi.mock('./use-menu-data', () => ({
  useMenuData: () => ({ data: MENU, loading: false, error: null, reload: vi.fn() }),
  usePosCatalogue: () => ({
    data: MENU,
    loading: false,
    error: null,
    reload: vi.fn(),
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    total: 1,
    loadedCount: 1,
    promotionRules: [],
  }),
}));

const { PosCounterWorkspace } = await import('./pos-counter-workspace');

// ── harness ──────────────────────────────────────────────────────────────────

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function mount(linkedSessionId: string | null) {
  render(
    <ConfirmProvider>
      <PosCounterWorkspace
        session={session}
        branchId="brn_1"
        initialMode="DINE_IN"
        linkedSessionId={linkedSessionId}
        onModeChange={vi.fn()}
      />
    </ConfirmProvider>,
  );
}

const sendButton = () => screen.getByRole('button', { name: /Confirm & send/ });

beforeEach(() => {
  listOpen.mockResolvedValue([OPEN_ROW]);
  getSession.mockResolvedValue(OPEN_ROW);
  getDetail.mockResolvedValue(DETAIL);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a session handed over by the floor plan (D155)', () => {
  it('opens bound to that table, named, with the rounds it already has', async () => {
    mount('ses_1');
    await settle();

    // POSITIVE — the strip names the TABLE, resolved from the area listing, and
    // not the session number the wire carries.
    await waitFor(() => expect(screen.getByText('Table 1')).toBeTruthy());
    // The header says it too: "Counter 1" is the till's description and reads as
    // the wrong room entirely on a screen opened from a table.
    expect(screen.getByText('Main · Table 1')).toBeTruthy();
    expect(screen.queryByText('Main · Counter 1')).toBeNull();
    // NEGATIVE — never the internal document id.
    expect(screen.queryByText(/TS-000042/)).toBeNull();

    /*
     * Two rounds, from the server's detail — not from a counter that starts at
     * zero on every mount, which told the next waiter "nothing sent yet" about
     * a table with four rounds on it. The DRAFT round in the fixture must not
     * be in the number.
     */
    await waitFor(() => expect(screen.getByText(/2 rounds sent/)).toBeTruthy());
    expect(screen.queryByText(/nothing sent yet/)).toBeNull();
  });

  it('offers no table picker and no Change table — the question is already answered', async () => {
    mount('ses_1');
    await settle();
    await waitFor(() => expect(screen.getByText('Table 1')).toBeTruthy());

    expect(screen.queryByText('Which table?')).toBeNull();
    expect(screen.queryByRole('button', { name: /Change table/ })).toBeNull();
    // Nor the order-type chip: switching to takeaway would strand the screen
    // between a table it no longer serves and a counter order it was not
    // opened for.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    // The way out is the floor, which the old screen offered in the same place.
    expect(screen.getByRole('link', { name: /Back to floor/ }).getAttribute('href')).toBe(
      '/tables',
    );
  });

  it('arms Confirm & send on the first item, with no table to pick first', async () => {
    mount('ses_1');
    await settle();
    await waitFor(() => expect(screen.getByText('Table 1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Rice and Curry/ }));

    await waitFor(() => expect(sendButton().hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/Pick a table above/)).toBeNull();
  });

  it('NEGATIVE — with no session in the URL the picker is still the first question', async () => {
    mount(null);
    await settle();

    expect(await screen.findByText('Which table?')).toBeTruthy();
    expect(screen.getByText('Main · Counter 1')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Back to floor/ })).toBeNull();

    // And the send stays refused, with the reason on screen: this is the D69
    // gate, which the link satisfies rather than removes.
    fireEvent.click(screen.getByRole('button', { name: /Rice and Curry/ }));
    await waitFor(() => expect(sendButton().hasAttribute('disabled')).toBe(true));
    expect(screen.getByText(/Pick a table above/)).toBeTruthy();
  });

  it('says so when the session has already been billed, and hands back the picker', async () => {
    // Absent from the open sessions — closed, or another waiter's (the listing
    // is D70-scoped). `get` then supplies the Sale it was billed into.
    listOpen.mockResolvedValue([]);
    getSession.mockResolvedValue({ ...OPEN_ROW, status: 'CLOSED', finalSaleId: 'sale_9' });

    mount('ses_1');
    await settle();

    expect(await screen.findByText(/no longer open/)).toBeTruthy();
    // Not a dead end: the bill it became, and the floor. And the picker is back,
    // because a waiter in front of a billed table still has four others.
    fireEvent.click(screen.getByRole('button', { name: 'View bill' }));
    expect(push).toHaveBeenCalledWith('/bills/sale_9');
    expect(await screen.findByText('Which table?')).toBeTruthy();
    // NEGATIVE — nothing claims to be serving a table that has been billed.
    expect(screen.queryByText('Table 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Order so far' })).toBeNull();
  });

  it('says so when the table cannot be read at all, and hands back the picker', async () => {
    listOpen.mockRejectedValue(new Error('Network unreachable'));

    mount('ses_1');
    await settle();

    expect(await screen.findByText(/Network unreachable/)).toBeTruthy();
    expect(await screen.findByText('Which table?')).toBeTruthy();
    expect(screen.queryByText('Table 1')).toBeNull();
  });
});
