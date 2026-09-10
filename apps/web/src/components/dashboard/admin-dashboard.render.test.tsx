/**
 * D161 — the dashboard's quick actions go where they say they go.
 *
 * ## What was reported
 *
 * "in dashbord in retail when click on 'view reports' btn its goes to sales
 * its needed to go to reports"
 *
 * It did. The action was labelled "View Reports", carried the Reports icon and
 * was gated on `REPORT_READ` — every signal about it said Reports except the
 * one that decides where the browser goes.
 *
 * ## Why nothing caught it
 *
 * Nothing rendered this dashboard. A wrong `href` is invisible to typechecking
 * (it is a string), invisible to lint, and invisible to every other spec in the
 * suite. It can only be caught by asserting the destination, which is what this
 * file does and what did not exist.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Each action is asserted by its EXACT destination, not by "a link exists" —
 * the bug was a link that existed and worked and went somewhere real, so
 * presence proves nothing here.
 *
 * The reports case also asserts the old wrong value is gone. `/sales` is a
 * legitimate destination elsewhere on this screen (several KPI cards drill into
 * it on purpose), so "does not link to /sales" has to be said about this action
 * specifically rather than about the page.
 *
 * The other two actions are the control: they pin destinations this change did
 * not touch, so "the reports link is right" cannot pass because the action list
 * collapsed to one entry or every href was rewritten.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@/lib/permissions';

// `next/link` reaches for router context no unit render provides. The same
// one-line stand-in the settings and restaurant-dashboard specs use.
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

// The KPI cards navigate programmatically on click, so the tree reaches for
// the App Router. Nothing here clicks one; it only has to exist.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/*
 * The dashboard's data, stubbed empty. Every figure on the screen is beside
 * the point here: this spec is about where the actions POINT, and an empty
 * dashboard still renders its action bar.
 */
vi.mock('@/lib/dashboard/use-dashboard-data', () => ({
  useDashboardData: () => ({
    loading: false,
    error: null,
    lastUpdatedLabel: '',
    refresh: vi.fn(),
    stats: null,
    recentSales: [],
    quotations: [],
    // These four are dereferenced without a guard by the alert builder,
    // so they are given real (empty) shapes rather than null. Zeroes mean
    // "nothing to alert about", which keeps the screen down to the parts
    // this spec is actually about.
    stock: { outOfStock: 0, lowStock: 0 },
    pipeline: { openCount: 0, stages: [] },
    quickbooks: { failedSyncs: 0, waitingToSync: 0 },
    summary: null,
    paymentMethods: [],
    topCategories: [],
    frequentItems: [],
    shift: null,
  }),
}));

/*
 * jsdom implements no `matchMedia`, and the chart components ask it about
 * reduced motion on mount. Same stand-in `use-viewport.render.test.tsx`
 * installs, minus its change-firing: nothing here depends on the answer, it
 * only has to be answerable.
 */
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { AdminDashboard } = await import('./admin-dashboard');

const SESSION = {
  user: { id: 'usr_1', tenantId: 't1', name: 'Themiya', role: 'OWNER' },
  branchId: 'brn_1',
} as unknown as Parameters<typeof AdminDashboard>[0]['session'];

/** Every permission, unless a case says otherwise. */
const ALL = () => true;

function mount(hasPermission: (p: Permission) => boolean = ALL) {
  render(<AdminDashboard session={SESSION} hasPermission={hasPermission} />);
}

/**
 * The hero renders its secondary actions twice — inline for wide viewports and
 * again inside a "More actions" menu — and jsdom lays neither out, so both are
 * in the document. The destination is the claim, so every copy must agree.
 */
function hrefsFor(label: string): string[] {
  return screen
    .getAllByRole('link', { name: new RegExp(`^${label}$`, 'i') })
    .map((el) => el.getAttribute('href') ?? '');
}

afterEach(cleanup);

describe('D161 — dashboard quick actions', () => {
  it('View Reports opens Reports, not the sales list', () => {
    mount();

    const hrefs = hrefsFor('View Reports');

    // It is rendered at all — otherwise the negative below passes trivially.
    expect(hrefs.length).toBeGreaterThan(0);
    // POSITIVE — every copy of it goes to Reports…
    expect(new Set(hrefs)).toEqual(new Set(['/reports']));
    // …NEGATIVE — and none of them goes where the bug sent them. Said about
    // THIS action, because `/sales` is a correct destination elsewhere on the
    // same screen.
    expect(hrefs).not.toContain('/sales');
  });

  it('the actions it sits beside still point where they did', () => {
    /*
     * The control. Without it, "View Reports goes to /reports" would pass for
     * a dashboard whose action list had been reduced to that one entry, or
     * whose every href had been rewritten to the same string.
     */
    mount();

    expect(new Set(hrefsFor('Create Quote'))).toEqual(new Set(['/quotations/new']));
    expect(new Set(hrefsFor('Add Product'))).toEqual(new Set(['/products/new']));
  });

  it('is offered only to an operator who may read reports', () => {
    // The gate, unchanged by D161 and asserted so the fix cannot have widened
    // it: the same REPORT_READ the sidebar's /reports entry requires.
    mount((p) => p !== Permission.REPORT_READ);

    expect(screen.queryAllByRole('link', { name: /^View Reports$/i })).toEqual([]);
    // …and the rest of the bar is still there, so this cannot pass because
    // the dashboard rendered nothing at all.
    expect(hrefsFor('Create Quote').length).toBeGreaterThan(0);
  });
});
