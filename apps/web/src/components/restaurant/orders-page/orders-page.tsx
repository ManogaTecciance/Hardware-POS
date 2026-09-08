'use client';

import { Filter, RefreshCw, Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { normalizeSearchTerm } from '@/lib/search-term';
import { type Session } from '@/lib/auth';
import { restaurantOrders } from '@/lib/restaurant/api';
import { formatElapsed, formatMoney } from '@/lib/restaurant/labels';
import type {
  UnifiedChannel,
  UnifiedOrderStatus,
  UnifiedOrderView,
} from '@/lib/restaurant/types';

import { OrderDetailDrawer } from './order-detail-drawer';
import {
  PAYMENT_LABELS,
  PAYMENT_TONES,
  PAYMENT_UNTRACKED_LABEL,
  UNIFIED_CHANNEL_LABELS,
  UNIFIED_CHANNEL_TONES,
  UNIFIED_SOURCE_LABELS,
  UNIFIED_STATUS_LABELS,
  UNIFIED_STATUS_TONES,
} from './orders-labels';

type PaymentFilter = 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'ALL';

/** yyyy-mm-dd or nothing — the shape `<input type="date">` emits. */
function parseDateParam(v: string | null): string {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

interface Props {
  session: Session;
  branchId: string;
}

/*
 * D110 (PO): no Completed tab. COMPLETED is the dine-in shell's closed
 * state — those rows still exist under All Orders (and the server still
 * accepts ?status=COMPLETED from an old bookmark); the strip shows the
 * lifecycle the counter actually works: Pending → Preparing → Ready →
 * Handed over, plus Cancelled.
 */
const STATUS_TABS: Array<{ key: UnifiedOrderStatus | 'ALL'; label: string }> = [
  { key: 'ALL', label: 'All Orders' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'IN_PROGRESS', label: 'Preparing' },
  { key: 'READY', label: 'Ready' },
  { key: 'HANDED_OVER', label: 'Handed over' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

const CHANNEL_CHIPS: Array<{ key: UnifiedChannel | 'ALL'; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'DINE_IN', label: 'Dining' },
  { key: 'TAKEAWAY', label: 'Takeaway' },
  { key: 'THIRD_PARTY', label: '3rd Party' },
];

/**
 * The unified Orders screen. Filters live in the URL so a manager can
 * bookmark "Takeaway Ready" and share it. The page polls the unified
 * `/restaurant/branches/:b/orders` endpoint every 8 s while the tab is
 * visible (a hidden tab stops polling and catches up on return).
 *
 * D111 (PO): this screen makes NO sound. It once rang a new-order chime and
 * (D107) a food-ready bell; the PO wants audio in the kitchen alone, so the
 * queue informs visually — status chips, tab counts, the Ready tab. The
 * server still tallies `readyHandoverCount` in the envelope (tested,
 * harmless) should the bell ever be invited back.
 */
/**
 * Rows per page for this screen.
 *
 * Sent explicitly rather than left to the server's default, so the size the
 * screen wants is visible in the request instead of being an unstated
 * agreement between two files. The server still clamps it, which is why the
 * arithmetic below reads the size it echoed back rather than this constant.
 */
const ORDERS_PAGE_SIZE = 25;
/**
 * The Rows-per-page choices (PO request) — the customers-list pattern on the
 * queue. Bounded by the server's clamp (1..100), defaulting to the size this
 * screen has always used; the default stays out of the URL like page 1.
 */
const PAGE_SIZES = [25, 50, 75, 100] as const;

export function OrdersPage({ session, branchId }: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const channel = (params.get('channel') ?? 'ALL') as UnifiedChannel | 'ALL';
  const status = (params.get('status') ?? 'ALL') as UnifiedOrderStatus | 'ALL';
  const partner = params.get('partner') ?? 'ALL';
  const search = params.get('search') ?? '';
  // Guarded like the server guards it: a mangled shared link degrades to
  // "All" rather than sending a value the API would coerce anyway.
  const paymentRaw = params.get('payment');
  const payment: PaymentFilter =
    paymentRaw === 'UNPAID' || paymentRaw === 'PARTIAL' || paymentRaw === 'PAID' || paymentRaw === 'REFUNDED'
      ? paymentRaw
      : 'ALL';
  // yyyy-mm-dd from the date inputs; anything else is treated as unset.
  const from = parseDateParam(params.get('from'));
  const to = parseDateParam(params.get('to'));
  const page = Math.max(Number(params.get('page') ?? '1') || 1, 1);
  // Guarded to the offered sizes: a mangled ?size degrades to the default
  // rather than sending the server something it would clamp anyway.
  const sizeRaw = Number(params.get('size'));
  const requestedSize = (PAGE_SIZES as readonly number[]).includes(sizeRaw)
    ? sizeRaw
    : ORDERS_PAGE_SIZE;
  const openId = params.get('open');

  const [rows, setRows] = React.useState<UnifiedOrderView[]>([]);
  const [total, setTotal] = React.useState(0);
  const [truncated, setTruncated] = React.useState(false);
  const [statusCounts, setStatusCounts] = React.useState<Record<UnifiedOrderStatus, number> | null>(
    null,
  );
  /*
   * The size the SERVER actually used, echoed back on every response.
   *
   * Still read from the response even though the request now names a size:
   * the server clamps (1..100), so what it used is not always what was asked
   * for. Dividing `total` by the requested size instead would report pages
   * that do not exist the moment a size outside that range is sent. The seed
   * only covers the first render, before any response has landed and while the
   * pager is hidden.
   */
  const [pageSize, setPageSize] = React.useState(ORDERS_PAGE_SIZE);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = React.useState<Date | null>(null);
  // Opens itself when a shared link arrives carrying one of its filters —
  // hiding an ACTIVE filter behind a closed panel reads as a broken list.
  const [showMore, setShowMore] = React.useState(payment !== 'ALL' || !!from || !!to);
  const [localSearch, setLocalSearch] = React.useState(search);

  // Debounce URL writes for search so every keystroke doesn't push a new
  // history entry.
  React.useEffect(() => {
    const t = setTimeout(() => {
      /*
       * Normalised where the keystrokes become a QUERY, not in the input — the
       * operator keeps seeing what they typed, and only what is sent is
       * cleaned. The server matches with `contains`, so "table  4" is a
       * substring of nothing and returned an empty list for an order that
       * exists; the ends were not trimmed either, so a stray leading space did
       * the same.
       *
       * Comparing the NORMALISED value against the URL is what stops a
       * trailing space re-triggering this effect forever: `"4 "` collapses to
       * `"4"`, matches the URL, and writes nothing.
       */
      const applied = normalizeSearchTerm(localSearch);
      if (applied === search) return;
      // No `page`: a new term must start at page 1, or the reader lands on
      // page 4 of a result set that may only have one page.
      const q = buildQuery({
        channel,
        status,
        partner,
        payment,
        from,
        to,
        size: requestedSize,
        search: applied,
      });
      router.replace(`/orders${q}`);
    }, 250);
    return () => clearTimeout(t);
  }, [localSearch, channel, status, partner, payment, from, to, requestedSize, search, router]);

  const load = React.useCallback(() => {
    setLoading(true);
    restaurantOrders
      .list(session, branchId, {
        channel,
        status,
        paymentStatus: payment,
        search: search || undefined,
        /*
         * The inputs give calendar DATES; the API compares instants. `from`
         * means "from the start of that day" and `to` means "through the END
         * of it" — sending midnight for both would silently drop everything
         * ordered after 00:00 on the `to` day, which is the whole day. Local
         * time on purpose: the operator's "today" is the till's day, not UTC's.
         */
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        page,
        pageSize: requestedSize,
      })
      .then((res) => {
        setRows(res.items);
        setTotal(res.total);
        setTruncated(res.truncated);
        setStatusCounts(res.statusCounts);
        setPageSize(res.pageSize);
        setRefreshedAt(new Date());
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load orders'))
      .finally(() => setLoading(false));
  }, [session, branchId, channel, status, payment, from, to, search, page, requestedSize]);

  React.useEffect(() => {
    load();
  }, [load]);

  /*
   * The 8 s poll only runs while the tab is actually on someone's screen — a
   * queue left open behind the POS would otherwise hit the API all shift for
   * nobody. `focus`/`visibilitychange` refetch immediately on return, so
   * coming back never means waiting out the rest of an interval on stale
   * rows. Same shape as the dashboard's poll (use-dashboard-data.ts).
   */
  React.useEffect(() => {
    const loadIfVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    const t = setInterval(loadIfVisible, 8000);
    window.addEventListener('focus', loadIfVisible);
    document.addEventListener('visibilitychange', loadIfVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', loadIfVisible);
      document.removeEventListener('visibilitychange', loadIfVisible);
    };
  }, [load]);

  const filteredByPartner = React.useMemo(() => {
    if (channel !== 'THIRD_PARTY' || partner === 'ALL') return rows;
    return rows.filter((r) => r.source === partner);
  }, [rows, channel, partner]);

  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const firstOnPage = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastOnPage = Math.min(page * pageSize, total);

  const metrics = React.useMemo(() => {
    /*
     * From the server's tally, not from `rows`. `rows` is one page now, so
     * counting it would report "5 pending" when the branch has ninety — and
     * nothing on screen would reveal the difference.
     */
    const count = (s: UnifiedOrderStatus) => statusCounts?.[s] ?? 0;
    return {
      total,
      pending: count('PENDING'),
      inProgress: count('IN_PROGRESS'),
      ready: count('READY'),
      completed: count('COMPLETED') + count('HANDED_OVER'),
      cancelled: count('CANCELLED'),
    };
  }, [statusCounts, total]);

  const patch = (next: Partial<{
    channel: UnifiedChannel | 'ALL';
    status: UnifiedOrderStatus | 'ALL';
    partner: string;
    payment: PaymentFilter;
    from: string;
    to: string;
    size: number;
    search: string;
    page: number;
    open: string | null;
  }>) => {
    /*
     * Narrowing the list resets to page 1 — and so does resizing it: page 3
     * of 25-row pages names different orders at 100 rows, so keeping the
     * number would land the reader somewhere new while claiming continuity.
     * Staying on page 4 while switching to a status that has one page shows
     * an empty grid over a full tab count, which reads as "the orders
     * vanished". Opening a drawer is not a filter, so it leaves the page
     * alone.
     */
    const narrows =
      'channel' in next ||
      'status' in next ||
      'partner' in next ||
      'payment' in next ||
      'from' in next ||
      'to' in next ||
      'size' in next ||
      'search' in next;
    const nextPage = 'page' in next ? next.page : narrows ? 1 : page;
    router.replace(
      `/orders${buildQuery({
        channel: next.channel ?? channel,
        status: next.status ?? status,
        partner: next.partner ?? partner,
        payment: next.payment ?? payment,
        from: next.from ?? from,
        to: next.to ?? to,
        size: next.size ?? requestedSize,
        search: next.search ?? search,
        page: nextPage,
        open: 'open' in next ? next.open : openId,
      })}`,
    );
  };

  const openRow = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Orders"
          description="Live queue across every channel · refreshes every 8 s"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} leftIcon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
          {refreshedAt ? (
            <span className="text-xs text-muted-foreground">
              Last {formatElapsed(refreshedAt.toISOString())}
            </span>
          ) : null}
        </div>
      </div>

      {/* Metrics strip */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Metric label="Total orders" value={metrics.total} hint={`${branchId ? 'Today · this branch' : ''}`} />
        <Metric label="Pending" value={metrics.pending} tone="warning" hint="Awaiting kitchen" />
        <Metric label="In progress" value={metrics.inProgress} tone="info" hint="Being prepared" />
        <Metric label="Ready" value={metrics.ready} tone="success" hint="For handover" />
        <Metric label="Completed" value={metrics.completed} tone="muted" hint="Closed today" />
        <Metric label="Cancelled" value={metrics.cancelled} tone="danger" hint="Today" />
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="space-y-3 p-4">
          {/* Status tabs — 7 pills that would wrap into two rows on tablet
              portrait. ChipRow keeps them single-line and scrollable. `py-3`
              lifts each pill's tap height from ~36px to ~44px. The bottom
              border stays on the outer wrapper so the underline reads as a
              tab strip rather than travelling with the scroll. */}
          <div className="border-b border-border pb-2">
            <ChipRow
              ariaLabel="Filter by order status"
              activeKey={String(status)}
            >
              {STATUS_TABS.map((t) => {
                const on = t.key === status;
                const count =
                  t.key === 'ALL'
                    ? // The ALL tab counts every status, which is what the
                      // tally sums to — `total` narrows to the active status.
                      Object.values(statusCounts ?? {}).reduce((a, b) => a + b, 0)
                    : (statusCounts?.[t.key] ?? 0);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => patch({ status: t.key })}
                    data-active={on}
                    className={`inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-3 text-sm font-medium transition-colors ${
                      on
                        /*
                         * `brand-700`, not `primary`. `--sem-action-primary` is
                         * Kinetic Teal in BOTH themes, so on the dark surface
                         * this sat at 1.83:1 against `brand-100` — dark teal on
                         * dark green, effectively unreadable. `--sem-brand-700`
                         * lifts to Flow Aqua under dark (see the ramp comment in
                         * globals.css) and reaches 6.14:1, while staying the same
                         * Kinetic Teal in light, where nothing changes. It is the
                         * token the sidebar's own Orders link already uses.
                         */
                        ? 'bg-brand-100 text-brand-700 shadow-[inset_0_-2px_0_0_var(--sem-accent)]'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {t.label}
                    <span
                      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${
                        on ? 'bg-brand-700/20 text-brand-700' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </ChipRow>
          </div>

          {/* Channel chips — the "Channel" label stays outside the scrollable
              region so it never disappears when a long strip is scrolled. */}
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Channel
            </span>
            <ChipRow
              ariaLabel="Filter by channel"
              activeKey={String(channel)}
              className="min-w-0 flex-1"
            >
              {CHANNEL_CHIPS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() =>
                    patch({
                      channel: c.key,
                      partner: c.key === 'THIRD_PARTY' ? partner : 'ALL',
                    })
                  }
                  data-active={c.key === channel}
                  className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors ${
                    c.key === channel
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground hover:bg-border'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </ChipRow>
          </div>

          {/* Partner chips — only when 3rd Party is active. The disclaimer
              stays below the scrollable strip so it never gets clipped by
              the overflow fades. */}
          {channel === 'THIRD_PARTY' ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Partner
                </span>
                <ChipRow
                  ariaLabel="Filter by delivery partner"
                  activeKey={String(partner)}
                  className="min-w-0 flex-1"
                >
                  {[
                    { k: 'ALL', l: 'All partners' },
                    { k: 'UBER_EATS', l: 'Uber Eats' },
                    { k: 'PICKME_FOOD', l: 'PickMe Food' },
                    { k: 'DOORDASH', l: 'DoorDash' },
                    { k: 'MOCK', l: 'Mock (dev)' },
                  ].map((p) => (
                    <button
                      key={p.k}
                      type="button"
                      onClick={() => patch({ partner: p.k })}
                      data-active={p.k === partner}
                      className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors ${
                        p.k === partner
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground hover:bg-border'
                      }`}
                    >
                      {p.l}
                    </button>
                  ))}
                </ChipRow>
              </div>
              <span className="block text-xs text-muted-foreground">
                Only the MOCK adapter is wired today; live Uber Eats / PickMe Food are deferred.
              </span>
            </div>
          ) : null}

          {/* Search + more filters */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder="Order #, customer, phone, table…"
                className="h-10 pl-9 pr-9"
              />
              {localSearch ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setLocalSearch('')}
                  // touch-target-coarse lifts the tap area to 44×44 on touch
                  // devices without changing the desktop footprint.
                  className="touch-target-coarse absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <Button
              size="sm"
              variant={payment !== 'ALL' || from || to ? 'secondary' : 'outline'}
              onClick={() => setShowMore((v) => !v)}
              leftIcon={<Filter className="h-4 w-4" />}
            >
              Filters
              {(payment !== 'ALL' ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0) > 0
                ? ` (${(payment !== 'ALL' ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)})`
                : ''}
            </Button>
          </div>

          {showMore ? (
            <div className="space-y-3 border-t border-dashed border-border pt-3">
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment
                </span>
                <ChipRow
                  ariaLabel="Filter by payment status"
                  activeKey={payment}
                  className="min-w-0 flex-1"
                >
                  {(['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'REFUNDED'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => patch({ payment: p })}
                      data-active={p === payment}
                      className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors ${
                        p === payment
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground hover:bg-border'
                      }`}
                    >
                      {p === 'ALL' ? 'Any payment' : PAYMENT_LABELS[p]}
                    </button>
                  ))}
                </ChipRow>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Placed
                </span>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  from
                  <Input
                    type="date"
                    aria-label="From date"
                    value={from}
                    // A `to` earlier than the new `from` cannot match anything;
                    // dragging it along keeps the range sane instead of showing
                    // an empty list the operator has to diagnose.
                    onChange={(e) =>
                      patch({
                        from: e.target.value,
                        ...(to && e.target.value && to < e.target.value
                          ? { to: e.target.value }
                          : {}),
                      })
                    }
                    max={to || undefined}
                    className="h-10 w-40"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  to
                  <Input
                    type="date"
                    aria-label="To date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => patch({ to: e.target.value })}
                    className="h-10 w-40"
                  />
                </label>
                {payment !== 'ALL' || from || to ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => patch({ payment: 'ALL', from: '', to: '' })}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="p-4 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : loading && rows.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading orders…
          </CardContent>
        </Card>
      ) : filteredByPartner.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No orders match this filter.
          </CardContent>
        </Card>
      ) : (
        // On tab: (900) we intentionally keep the 2-column layout — pushing to
        // three columns at 900px squeezes each card under ~290px and truncates
        // the item preview badly. The third column returns at xl: (1280).
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 tab:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredByPartner.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => patch({ open: r.id })}
              className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary hover:shadow"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold">#{r.orderNumber}</p>
                  <p className="text-sm">{r.contextLabel ?? r.customerName ?? '—'}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge
                    label={UNIFIED_CHANNEL_LABELS[r.channel]}
                    tone={UNIFIED_CHANNEL_TONES[r.channel]}
                  />
                  {/* Partner chip only. On first-party channels the source
                      (POS / walk-in / phone) repeats what the channel badge
                      already says; on 3rd-party it is the one thing naming
                      the partner, so it stays. */}
                  {r.channel === 'THIRD_PARTY' ? (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {UNIFIED_SOURCE_LABELS[r.source]}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatElapsed(r.createdAt)}
                {r.pickupAt ? ` · Pickup ${new Date(r.pickupAt).toLocaleTimeString()}` : ''}
              </p>
              {r.itemPreview.length > 0 ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {r.itemCount} item{r.itemCount === 1 ? '' : 's'} —{' '}
                  {r.itemPreview.map((i) => `${i.qty}× ${i.name}`).join(', ')}
                  {r.itemCount > r.itemPreview.length ? ', …' : ''}
                </p>
              ) : null}
              <div className="mt-1 flex items-center justify-between border-t border-dashed border-border pt-2">
                <div className="flex items-center gap-1.5">
                  <StatusBadge
                    label={UNIFIED_STATUS_LABELS[r.unifiedStatus]}
                    tone={UNIFIED_STATUS_TONES[r.unifiedStatus]}
                  />
                  {/*
                    A badge either way. This used to fall back to bare
                    "payment —" text, which read as broken markup beside the
                    pills and told a cashier nothing. The absent case is now
                    rare and specific — third-party (the platform collects) or
                    cancelled/draft (nothing owed) — because a live unbilled
                    order reports UNPAID rather than nothing.
                  */}
                  {r.paymentStatus ? (
                    <StatusBadge
                      label={PAYMENT_LABELS[r.paymentStatus]}
                      tone={PAYMENT_TONES[r.paymentStatus]}
                    />
                  ) : (
                    <StatusBadge label={PAYMENT_UNTRACKED_LABEL} tone="muted" />
                  )}
                </div>
                <span className="text-sm font-bold text-brand-700">
                  {r.total ? formatMoney(r.total) : '—'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/*
        Numbered paging rather than infinite scroll: this list is read against a
        docket in hand, and "I was on page 3" has to survive a refresh — which
        is why the page (and the chosen size) live in the URL beside the
        filters. Gated on the MINIMUM size, not the current one — the
        customers-list rule — so picking a larger size never makes the
        selector itself vanish; the Prev/Next pair still only shows when a
        second page exists.
      */}
      {total > PAGE_SIZES[0] ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Rows per page</span>
            <Select
              value={String(requestedSize)}
              onChange={(e) => patch({ size: Number(e.target.value) })}
              className="w-auto"
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <span role="status">
              Showing {firstOnPage}–{lastOnPage} of {total} order{total === 1 ? '' : 's'}
            </span>
          </div>
          {pageCount > 1 ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => patch({ page: page - 1 })}
                disabled={page <= 1 || loading}
              >
                Previous
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => patch({ page: page + 1 })}
                disabled={page >= pageCount || loading}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {truncated ? (
        <p className="text-xs text-warning" role="status">
          More than {total} orders match. Narrow the date range or filters to see the rest.
        </p>
      ) : null}

      {openRow ? (
        <OrderDetailDrawer
          order={openRow}
          branchId={branchId}
          onClose={() => patch({ open: null })}
          onMutated={load}
        />
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'warning' | 'info' | 'success' | 'muted' | 'danger';
}) {
  const cls =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'info'
        ? 'text-info'
        : tone === 'success'
          ? 'text-success'
          : tone === 'danger'
            ? 'text-danger'
            : tone === 'muted'
              ? 'text-muted-foreground'
              : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${cls}`}>{value}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function buildQuery(f: {
  channel: UnifiedChannel | 'ALL';
  status: UnifiedOrderStatus | 'ALL';
  partner: string;
  payment: PaymentFilter;
  from: string;
  to: string;
  size: number;
  search: string;
  page?: number;
  open?: string | null;
}): string {
  const params = new URLSearchParams();
  if (f.channel !== 'ALL') params.set('channel', f.channel);
  if (f.status !== 'ALL') params.set('status', f.status);
  if (f.partner !== 'ALL') params.set('partner', f.partner);
  if (f.payment !== 'ALL') params.set('payment', f.payment);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  // The default size stays out of the URL, like page 1 below.
  if (f.size !== ORDERS_PAGE_SIZE) params.set('size', String(f.size));
  if (f.search) params.set('search', f.search);
  // Page 1 is the default, so it stays out of the URL — a shared link to the
  // first page looks like a plain filter link.
  if (f.page && f.page > 1) params.set('page', String(f.page));
  if (f.open) params.set('open', f.open);
  const s = params.toString();
  return s ? `?${s}` : '';
}
