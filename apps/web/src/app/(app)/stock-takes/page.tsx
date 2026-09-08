'use client';

/**
 * Stock count — D132 (`8.7`).
 *
 * Two halves: build a count, and read the counts already taken.
 *
 * ## What this screen deliberately does not do
 *
 * It never sends an expected quantity or a variance. The operator types what is
 * on the shelf; the server reads the book value inside the transaction that
 * applies the count. A screen left open for an hour would otherwise compute a
 * correction from a number that has since moved.
 *
 * The on-hand figure IS shown while building the count, labelled "system" — it
 * helps a counter notice a gross error before submitting — but it is a hint, and
 * the variance that comes back may differ from it if a sale landed meanwhile.
 * That is the correct behaviour and the reason the hint is labelled rather than
 * presented as the answer.
 */

import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { fetchProducts, type ManagedProduct } from '@/lib/products-api';
import {
  fetchVariantInventory,
  fetchVariants,
  type ProductVariant,
} from '@/lib/products/variants-api';
import {
  createStockTake,
  listStockTakes,
  type StockTakeView,
} from '@/lib/stock-takes';
import { formatReportMoney } from '@/lib/reports';

interface DraftLine {
  key: string;
  productId: string;
  productVariantId?: string;
  label: string;
  /** Last known on-hand, for the operator's eyes only. */
  systemQuantity: number | null;
  countedQuantity: string;
}

export default function StockTakePage() {
  const { session } = useAuth();
  const [lines, setLines] = React.useState<DraftLine[]>([]);
  const [note, setNote] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [posted, setPosted] = React.useState<StockTakeView | null>(null);
  const [history, setHistory] = React.useState<StockTakeView[] | null>(null);

  const reloadHistory = React.useCallback(() => {
    if (!session) return;
    listStockTakes(session)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [session]);

  React.useEffect(reloadHistory, [reloadHistory]);

  if (!session) return null;

  const addLine = (line: DraftLine) => {
    let added = false;
    setLines((current) => {
      // The same shelf twice is a form error the server also refuses; catching it
      // here means the counter finds out while they can still fix it.
      if (current.some((l) => l.key === line.key)) return current;
      added = true;
      return [...current, line];
    });
    if (!added || !line.productVariantId || !session) return;

    // The system figure for a variant lives per branch and is not on the variant
    // row, so it is fetched after the line appears rather than blocking the tap.
    // A failure leaves the hint blank; it never stops the count.
    void fetchVariantInventory(session, line.productId, line.productVariantId)
      .then((inventory) => {
        const here = inventory.branches.find((b) => b.branchId === session.branchId);
        if (!here) return;
        setLines((current) =>
          current.map((l) =>
            l.key === line.key ? { ...l, systemQuantity: here.quantityOnHand } : l,
          ),
        );
      })
      .catch(() => undefined);
  };

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      const view = await createStockTake(session, {
        branchId: session.branchId!,
        note: note.trim() || undefined,
        // A stable key per submission attempt: pressing the button twice must
        // not post the correction twice.
        idempotencyKey: `count-${session.user.id}-${lines.map((l) => l.key).join(',')}-${lines
          .map((l) => l.countedQuantity)
          .join(',')}`,
        lines: lines.map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId,
          countedQuantity: Number(l.countedQuantity),
        })),
      });
      setPosted(view);
      setLines([]);
      setNote('');
      reloadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post this count.');
    } finally {
      setSaving(false);
    }
  };

  const ready =
    lines.length > 0 &&
    lines.every((l) => l.countedQuantity !== '' && Number(l.countedQuantity) >= 0) &&
    Boolean(session.branchId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock count"
        description="Count a shelf and correct the books. A count states what is there; it is never refused for disagreeing."
      />

      {!session.branchId ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch, and a count is always of one branch&apos;s shelf.
          </CardContent>
        </Card>
      ) : (
        <>
          <ProductPicker session={session} onAdd={addLine} />

          <Card>
            <CardHeader>
              <CardTitle>This count</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {lines.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing added yet. Search for a product above and add what you have counted.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="pb-1 text-left">Item</th>
                        <th className="pb-1 text-right">System</th>
                        <th className="pb-1 text-right">Counted</th>
                        <th className="pb-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.key} className="border-t border-border">
                          <td className="py-1.5">{line.label}</td>
                          <td className="py-1.5 text-right text-muted-foreground">
                            {line.systemQuantity ?? '—'}
                          </td>
                          <td className="py-1.5 text-right">
                            <Input
                              type="number"
                              min={0}
                              step="0.001"
                              className="ml-auto w-28 text-right"
                              value={line.countedQuantity}
                              onChange={(e) =>
                                setLines((cur) =>
                                  cur.map((l) =>
                                    l.key === line.key
                                      ? { ...l, countedQuantity: e.target.value }
                                      : l,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="py-1.5 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setLines((cur) => cur.filter((l) => l.key !== line.key))
                              }
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="count-note">Note</Label>
                <Textarea
                  id="count-note"
                  rows={2}
                  placeholder="Friday cycle count — shelf 3"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}

              <div className="flex items-center gap-3">
                <Button onClick={submit} disabled={!ready || saving}>
                  {saving ? 'Posting…' : 'Post count'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Posting corrects the stock immediately and records the difference in the stock
                  ledger. A count cannot be edited afterwards — recount instead.
                </p>
              </div>
            </CardContent>
          </Card>

          {posted ? <PostedCount view={posted} onDismiss={() => setPosted(null)} /> : null}
          <CountHistory history={history} />
        </>
      )}
    </div>
  );
}

/** Search products, then a variant if the product has any. */
function ProductPicker({
  session,
  onAdd,
}: {
  session: ReturnType<typeof useAuth>['session'];
  onAdd: (line: DraftLine) => void;
}) {
  const [term, setTerm] = React.useState('');
  const [results, setResults] = React.useState<ManagedProduct[]>([]);
  const [chosen, setChosen] = React.useState<ManagedProduct | null>(null);
  const [variants, setVariants] = React.useState<ProductVariant[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  if (!session) return null;

  const search = async () => {
    setSearching(true);
    try {
      const page = await fetchProducts(session, { search: term, pageSize: 20, isActive: 'true' });
      setResults(page.items);
    } finally {
      setSearching(false);
    }
  };

  const choose = async (product: ManagedProduct) => {
    setChosen(product);
    setVariants(null);
    if (product.hasVariants) setVariants(await fetchVariants(session, product.id));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add what you counted</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Product name or SKU"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <Button variant="outline" onClick={() => void search()} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>

        {results.length > 0 && !chosen ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => void choose(p)}
                >
                  <span>{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.hasVariants ? `${p.variantCount ?? 0} variants` : (p.sku ?? '—')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {chosen ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{chosen.name}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setChosen(null);
                  setVariants(null);
                }}
              >
                Back
              </Button>
            </div>

            {chosen.hasVariants ? (
              variants === null ? (
                <p className="text-sm text-muted-foreground">Loading variants…</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {variants.map((v) => (
                    <Button
                      key={v.id}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onAdd({
                          key: `${chosen.id}|${v.id}`,
                          productId: chosen.id,
                          productVariantId: v.id,
                          label: `${chosen.name} — ${
                            v.optionValues.map((o) => o.optionName).join(' / ') || v.sku
                          }`,
                          // Filled in asynchronously below. `null` until then,
                          // and `null` for good if the lookup fails — the hint is
                          // a courtesy and its absence must not block a count.
                          systemQuantity: null,
                          countedQuantity: '',
                        })
                      }
                    >
                      {v.optionValues.map((o) => o.optionName).join(' / ') || v.sku}
                    </Button>
                  ))}
                </div>
              )
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onAdd({
                    key: `${chosen.id}|`,
                    productId: chosen.id,
                    label: chosen.name,
                    systemQuantity: chosen.quantityOnHand,
                    countedQuantity: '',
                  })
                }
              >
                Add {chosen.name}
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The variance report for the count that was just posted. */
function PostedCount({ view, onDismiss }: { view: StockTakeView; onDismiss: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{view.countNumber} posted</CardTitle>
        <p className="text-sm text-muted-foreground">
          {view.varianceLines === 0
            ? 'Every line matched the books. Nothing was corrected, and nothing was written to the stock ledger.'
            : `${view.varianceLines} of ${view.lines.length} lines differed.`}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <VarianceTable view={view} />
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Start another count
        </Button>
      </CardContent>
    </Card>
  );
}

function VarianceTable({ view }: { view: StockTakeView }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="pb-1 text-left">Item</th>
              <th className="pb-1 text-right">Expected</th>
              <th className="pb-1 text-right">Counted</th>
              <th className="pb-1 text-right">Variance</th>
              <th className="pb-1 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((line) => {
              const short = line.variance.startsWith('-');
              return (
                <tr
                  key={`${line.productId}|${line.productVariantId ?? '-'}`}
                  className="border-t border-border"
                >
                  <td className="py-1.5">
                    {line.productName}
                    {line.variantName ? ` — ${line.variantName}` : ''}
                  </td>
                  <td className="py-1.5 text-right">{trim(line.expectedQuantity)}</td>
                  <td className="py-1.5 text-right">{trim(line.countedQuantity)}</td>
                  <td className={short ? 'py-1.5 text-right text-destructive' : 'py-1.5 text-right'}>
                    {trim(line.variance)}
                  </td>
                  {/* An em dash, never a zero: an unvalued variance is not a
                      variance that cost nothing. */}
                  <td className="py-1.5 text-right">
                    {line.varianceValue === null ? '—' : formatReportMoney(line.varianceValue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        Net value of the differences:{' '}
        <span className="font-medium">{formatReportMoney(view.varianceValue)}</span>
      </p>
      {view.unvaluedLines > 0 ? (
        <p className="text-xs text-muted-foreground">
          {view.unvaluedLines} {view.unvaluedLines === 1 ? 'difference is' : 'differences are'} not
          included in that figure — nothing has ever been received against{' '}
          {view.unvaluedLines === 1 ? 'that item' : 'those items'}, so there is no cost to value it
          at.
        </p>
      ) : null}
    </div>
  );
}

function CountHistory({ history }: { history: StockTakeView[] | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Previous counts</CardTitle>
      </CardHeader>
      <CardContent>
        {history === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : history.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No counts yet. The first one you post will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-1 text-left">Count</th>
                  <th className="pb-1 text-left">When</th>
                  <th className="pb-1 text-left">By</th>
                  <th className="pb-1 text-right">Lines</th>
                  <th className="pb-1 text-right">Differences</th>
                  <th className="pb-1 text-right">Net value</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-1.5 font-mono text-xs">{s.countNumber}</td>
                    <td className="py-1.5">{new Date(s.countedAt).toLocaleString()}</td>
                    <td className="py-1.5">{s.countedByName ?? '—'}</td>
                    <td className="py-1.5 text-right">{s.lines.length}</td>
                    <td className="py-1.5 text-right">{s.varianceLines}</td>
                    <td className="py-1.5 text-right">{formatReportMoney(s.varianceValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** `"4.000"` → `"4"`. The digits are never recomputed, only trimmed. */
function trim(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
