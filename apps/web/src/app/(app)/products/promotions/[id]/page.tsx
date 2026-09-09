'use client';

import { ArrowLeft, Ban, Loader2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { fetchBranches, type BranchSummary } from '@/lib/products/branches-api';
import { describeTimeWindow } from '@/lib/products/promotion-schedule';
import {
  activatePromotion,
  deactivatePromotion,
  deletePromotion,
  fetchPromotion,
  labelForPromotionType,
  PROMOTION_CHANNEL_LABELS,
  PROMOTION_DAY_LABELS,
  PROMOTION_ROLE_LABELS,
  summarisePromotionSchedule,
  type Promotion,
} from '@/lib/products/promotions-api';
import { cn, formatMoney } from '@/lib/utils';

/**
 * Promotion detail — the read-only view of a saved promotion.
 *
 * Added because there wasn't one: every "look at this promotion" affordance
 * (the list's name link, its View link, the editor's post-save redirect) either
 * pointed at `/edit` or dropped the operator back on a list that shows a name,
 * a type badge and a schedule summary. So the items, the money, the branch and
 * channel scope and the stacking rule — everything the operator had just spent
 * a form configuring — were unverifiable, and for a PRODUCT_READ user, who the
 * edit route refuses outright, unreachable. `GET /promotions/:id` only ever
 * needed PRODUCT_READ, so the gap was purely a missing screen.
 *
 * Manage actions (Edit, Activate/Deactivate, Delete) mirror the list's row
 * actions rather than inventing a second vocabulary for the same operations.
 */
export default function PromotionDetailPage() {
  const { session, hasPermission } = useAuth();
  const canView = hasPermission(Permission.PRODUCT_READ);
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [promo, setPromo] = React.useState<Promotion | null>(null);
  const [branches, setBranches] = React.useState<BranchSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPromotion(session, id)
      .then((p) => {
        if (!cancelled) setPromo(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load promotion');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id]);

  /*
   * Branch names for `branchScope`, which is a list of ids. Rendering the ids
   * would repeat the 4.10 bug the item rows were fixed for — an operator
   * cannot recognise a cuid as their Kandy branch. A failure here is not worth
   * failing the page over: the scope falls back to the raw id.
   */
  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchBranches(session)
      .then((rows) => {
        if (!cancelled) setBranches(rows);
      })
      .catch(() => {
        /* names are a nicety here; the ids still render */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const toggleActive = async () => {
    if (!session || !promo) return;
    setBusy(true);
    setError(null);
    try {
      const next = promo.isActive
        ? await deactivatePromotion(session, promo.id)
        : await activatePromotion(session, promo.id);
      setPromo(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update promotion');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!session || !promo) return;
    setBusy(true);
    setError(null);
    try {
      await deletePromotion(session, promo.id);
      // The record this page is about no longer exists, so there is nothing to
      // come back to — replace rather than push.
      router.replace('/products/promotions');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete promotion');
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  if (!session) return null;

  const back = (
    <Link
      href="/products/promotions"
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      <ArrowLeft className="h-4 w-4" /> Back to promotions
    </Link>
  );

  if (!canView) {
    return (
      <div className="space-y-6">
        {back}
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to view promotions.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        {back}
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
          Loading promotion…
        </div>
      </div>
    );
  }

  if (!promo) {
    return (
      <div className="space-y-6">
        {back}
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Promotion not found'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const windowNotice = describeTimeWindow(promo.startTime ?? '', promo.endTime ?? '');
  const branchName = (branchId: string) =>
    branches.find((b) => b.id === branchId)?.name ?? branchId;

  return (
    <div className="space-y-6">
      {back}

      <PageHeader
        title={promo.name}
        description={promo.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{labelForPromotionType(promo.type)}</Badge>
            {promo.isActive ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="danger">Inactive</Badge>
            )}
          </div>
        }
      />

      {error ? (
        <p
          className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {/*
       * The same warning the list row carries: `isActive` is a flag, not a
       * promise that the promotion can ever fire. A detail view that showed
       * "Active" over a 12:56–12:57 window and said nothing would be the more
       * misleading of the two screens, since this is the one an operator opens
       * to find out why an offer isn't applying.
       */}
      {windowNotice ? (
        <p
          className={cn(
            'rounded-lg border p-3 text-sm',
            windowNotice.level === 'error'
              ? 'border-danger/40 bg-danger-soft text-danger'
              : 'border-warning/40 bg-warning-soft text-warning',
          )}
          role="alert"
        >
          {windowNotice.level === 'error' ? 'Never fires — ' : 'Very short — '}
          {windowNotice.message}
        </p>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/products/promotions/${promo.id}/edit`}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={toggleActive}
            className={promo.isActive ? 'text-danger' : 'text-success'}
          >
            {promo.isActive ? (
              <>
                <Ban className="h-4 w-4" /> Deactivate
              </>
            ) : (
              <>
                <RotateCcw className="h-4 w-4" /> Activate
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Offer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              <DetailRow label="Type" value={labelForPromotionType(promo.type)} />
              {/* Only the fields this type actually uses — the editor doesn't
                  ask for the others and the server nulls them, so showing
                  "Bundle price —" on a percentage discount would be noise. */}
              {promo.type === 'BUNDLE_FIXED_PRICE' ? (
                <DetailRow
                  label="Bundle price"
                  value={promo.fixedPrice != null ? formatMoney(promo.fixedPrice) : '—'}
                />
              ) : null}
              {promo.type === 'BUY_X_GET_Y' ? (
                <>
                  <DetailRow
                    label="Buy / Get"
                    value={`Buy ${promo.buyQuantity ?? 1}, get ${promo.getQuantity ?? 1}`}
                  />
                  {/* 100 IS free, and the editor now offers it as "Free"
                      rather than a number to know — so the detail says the
                      same word back. */}
                  <DetailRow
                    label="Reward"
                    value={
                      promo.percentageOff == null || promo.percentageOff === 100
                        ? 'Free'
                        : `${promo.percentageOff}% off`
                    }
                  />
                </>
              ) : null}
              {promo.type === 'PERCENTAGE_DISCOUNT' ? (
                <DetailRow
                  label="Percentage off"
                  value={promo.percentageOff != null ? `${promo.percentageOff}%` : '—'}
                />
              ) : null}
              {promo.type === 'FIXED_AMOUNT_DISCOUNT' ? (
                <>
                  <DetailRow
                    label="Amount off"
                    value={promo.amountOff != null ? formatMoney(promo.amountOff) : '—'}
                  />
                  <DetailRow
                    label="Minimum spend"
                    value={
                      promo.minimumSpend != null ? formatMoney(promo.minimumSpend) : 'No minimum'
                    }
                  />
                </>
              ) : null}
              <DetailRow
                label="Stacking"
                value={
                  promo.stackable
                    ? 'Can combine with other promotions'
                    : 'Cannot combine with other promotions'
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">
                Products{promo.items.length > 0 ? ` (${promo.items.length})` : ''}
              </CardTitle>
            </CardHeader>
            {promo.items.length === 0 ? (
              <CardContent className="p-4 pt-0 text-sm text-muted-foreground">
                No products linked — this promotion applies to nothing until one is added.
              </CardContent>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Product</th>
                      <th className="px-4 py-2.5 font-medium">Role</th>
                      <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {promo.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-4 py-2.5">
                          {/* 4.10 — the server joins the name; a deleted product
                              leaves it null, and saying so beats a bare cuid. */}
                          {item.productName ? (
                            <Link
                              href={`/products/${item.productId}`}
                              className="font-medium text-foreground hover:text-primary hover:underline"
                            >
                              {item.productName}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">Deleted product</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {PROMOTION_ROLE_LABELS[item.role]}
                        </td>
                        <td className="px-4 py-2.5 text-right">{item.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Schedule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              <DetailRow label="Summary" value={summarisePromotionSchedule(promo)} />
              <DetailRow
                label="Runs from"
                value={promo.startsOn ? promo.startsOn.slice(0, 10) : 'No start date'}
              />
              <DetailRow
                label="Runs until"
                value={promo.endsOn ? promo.endsOn.slice(0, 10) : 'No end date'}
              />
              <DetailRow
                label="Days"
                value={
                  promo.daysOfWeek.length === 0 || promo.daysOfWeek.length === 7
                    ? 'Every day'
                    : promo.daysOfWeek.map((d) => PROMOTION_DAY_LABELS[d]).join(', ')
                }
              />
              <DetailRow
                label="Time of day"
                value={
                  promo.startTime && promo.endTime
                    ? `${promo.startTime}–${promo.endTime}`
                    : 'All day'
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Where it applies</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              {/* An empty scope means "everywhere", not "nowhere" — the
                  evaluator treats it as unrestricted, and a blank row here
                  would read as the opposite. */}
              <DetailRow
                label="Branches"
                value={
                  promo.branchScope.length === 0
                    ? 'All branches'
                    : promo.branchScope.map(branchName).join(', ')
                }
              />
              <DetailRow
                label="Channels"
                value={
                  promo.channelScope.length === 0
                    ? 'All channels'
                    : promo.channelScope.map((c) => PROMOTION_CHANNEL_LABELS[c]).join(', ')
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Record</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              <DetailRow label="Created" value={formatTimestamp(promo.createdAt)} />
              <DetailRow label="Last updated" value={formatTimestamp(promo.updatedAt)} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete promotion?"
        description={`${promo.name} will be permanently deleted. This cannot be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void doDelete()} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Consider deactivating instead — a deactivated promotion can be reactivated later without
          reconfiguring items or schedule.
        </p>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <span className="text-xs uppercase text-muted-foreground">{label}</span>
      {/* break-words: a long branch list or a hand-typed name would otherwise
          push the card wider than its column. */}
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
