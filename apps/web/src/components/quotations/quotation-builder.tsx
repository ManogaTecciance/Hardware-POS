'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Trash2, UserPlus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ProductImage } from '@/components/product-image';
import { QuantityStepper } from '@/components/pos/quantity-stepper';
import { QuickAddCustomerDialog } from '@/components/pos/quick-add-customer-dialog';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  fetchCategoryTree,
  fetchProducts,
  resolveImageUrl,
  type CategoryNode,
  type ManagedProduct,
} from '@/lib/products-api';
import { fetchCustomers, type ManagedCustomer } from '@/lib/customers-api';
import {
  createQuotation,
  createRevision,
  updateQuotation,
  previewQuotation,
  type DiscountBasis,
  type DiscountType,
  type QuotationDetail,
  type QuotationItemInput,
  type QuotationPreview,
} from '@/lib/quotations';
import { formatMoney, cn } from '@/lib/utils';

interface Line {
  key: string;
  productId: string | null;
  productName: string;
  sku: string | null;
  imageUrl: string | null;
  unitType: string | null;
  quantity: number;
  unitPrice: number;
  discountType: DiscountType | '';
  discountValue: number;
  discountBasis: DiscountBasis;
  itemNote: string;
}

interface Props {
  mode: 'create' | 'edit' | 'revision';
  initial?: QuotationDetail;
  /**
   * Page heading rendered inside the catalog column, so the quotation panel
   * can start at the very top of the content area (just below the app header)
   * and claim the full height.
   */
  header?: React.ReactNode;
}

let keySeq = 0;
const nextKey = () => `l${keySeq++}`;

function lineFromProduct(p: ManagedProduct): Line {
  return {
    key: nextKey(),
    productId: p.id,
    productName: p.name,
    sku: p.sku,
    imageUrl: null,
    unitType: null,
    quantity: 1,
    unitPrice: p.unitPrice,
    discountType: '',
    discountValue: 0,
    discountBasis: 'LINE',
    itemNote: '',
  };
}

export function QuotationBuilder({ mode, initial, header }: Props) {
  const { session, hasPermission } = useAuth();
  const router = useRouter();

  const [products, setProducts] = React.useState<ManagedProduct[]>([]);
  const [categoryTree, setCategoryTree] = React.useState<CategoryNode[]>([]);
  const [customers, setCustomers] = React.useState<ManagedCustomer[]>([]);
  const [addedCustomers, setAddedCustomers] = React.useState<ManagedCustomer[]>([]);
  const [search, setSearch] = React.useState('');
  const [category, setCategory] = React.useState('All');
  const [subcategory, setSubcategory] = React.useState('All');
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);

  const [customerId, setCustomerId] = React.useState(initial?.customer?.id ?? '');
  const [lines, setLines] = React.useState<Line[]>(
    initial
      ? initial.items.map((it) => ({
          key: nextKey(),
          productId: it.productId,
          productName: it.productName,
          sku: it.sku,
          imageUrl: it.imageUrl,
          unitType: it.unitType,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discountType: it.discountType ?? '',
          discountValue: it.discountValue ?? 0,
          // Re-seeded when editing or revising: dropping it here would not go
          // stale, it would reprice the quotation on the next save.
          discountBasis: it.discountBasis ?? 'LINE',
          itemNote: it.itemNote ?? '',
        }))
      : [],
  );
  const [orderDiscountType, setOrderDiscountType] = React.useState<DiscountType | ''>(
    initial?.quotationDiscountType ?? '',
  );
  const [orderDiscountValue, setOrderDiscountValue] = React.useState(
    initial?.quotationDiscountValue ?? 0,
  );
  const [validUntil, setValidUntil] = React.useState(
    initial?.validUntil ? initial.validUntil.slice(0, 10) : '',
  );
  const [notes, setNotes] = React.useState(initial?.notes ?? '');
  const [terms, setTerms] = React.useState(initial?.termsAndConditions ?? '');
  const [changeReason, setChangeReason] = React.useState('');

  const [preview, setPreview] = React.useState<QuotationPreview | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session) return;
    // Load the whole active catalog (paging past the API's 200 cap), same as
    // the POS, so every product is browsable/searchable here too.
    void (async () => {
      const first = await fetchProducts(session, { page: 1, pageSize: 200, isActive: 'true' });
      const all = [...first.items];
      const totalPages = Math.ceil(first.total / 200);
      for (let p = 2; p <= totalPages; p += 1) {
        const next = await fetchProducts(session, { page: p, pageSize: 200, isActive: 'true' });
        all.push(...next.items);
      }
      setProducts(all);
    })();
    void fetchCategoryTree(session, true).then(setCategoryTree).catch(() => setCategoryTree([]));
    void fetchCustomers(session, { pageSize: 200 }).then((r) => setCustomers(r.items));
  }, [session]);

  const items: QuotationItemInput[] = React.useMemo(
    () =>
      lines.map((l) => ({
        productId: l.productId ?? undefined,
        productName: l.productName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountType: l.discountType || undefined,
        discountValue: l.discountType ? l.discountValue : undefined,
        // FIXED only — the API refuses a per-unit percentage, and this memo feeds
        // the debounced preview as well as every save path.
        discountBasis: l.discountType === 'FIXED' ? l.discountBasis : undefined,
        itemNote: l.itemNote || undefined,
      })),
    [lines],
  );

  // Debounced server-side recompute — the server is the source of truth.
  React.useEffect(() => {
    if (!session || lines.length === 0) {
      setPreview(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void previewQuotation(session, {
        items,
        quotationDiscountType: orderDiscountType || undefined,
        quotationDiscountValue: orderDiscountType ? orderDiscountValue : undefined,
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [session, items, orderDiscountType, orderDiscountValue, lines.length]);

  if (!session) return null;
  const canAddCustomer = hasPermission(Permission.CUSTOMER_MANAGE);

  const allCustomers = [...addedCustomers, ...customers];

  // Resolve product category/subcategory names for the POS-style chip filters.
  const catNameById = new Map(categoryTree.map((c) => [c.id, c.name]));
  const subNameById = new Map<string, string>();
  for (const c of categoryTree) for (const s of c.subcategories) subNameById.set(s.id, s.name);

  const categories = ['All', ...categoryTree.map((c) => c.name)];
  const activeCategory = categoryTree.find((c) => c.name === category);
  const subcategories =
    category !== 'All' && activeCategory && activeCategory.subcategories.length > 0
      ? ['All', ...activeCategory.subcategories.map((s) => s.name)]
      : [];

  const q = search.trim().toLowerCase();
  const filteredProducts = products.filter((p) => {
    const catName = (p.categoryId && catNameById.get(p.categoryId)) || 'Uncategorized';
    const subName = (p.subcategoryId && subNameById.get(p.subcategoryId)) || null;
    const matchesCat = category === 'All' || catName === category;
    const matchesSub = subcategory === 'All' || subName === subcategory;
    const matchesQuery =
      !q || p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q);
    return matchesCat && matchesSub && matchesQuery;
  });

  function addProduct(p: ManagedProduct) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing)
        return prev.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, lineFromProduct(p)];
    });
  }

  /**
   * A line's total (qty x unit price, minus its discount). Prefers the
   * server-computed preview figure (the source of truth for rounding);
   * falls back to a local estimate while the debounced preview loads.
   */
  function lineTotal(l: Line, index: number): number {
    const fromPreview = preview?.items[index]?.lineTotal;
    if (fromPreview != null) return fromPreview;
    const subtotal = l.quantity * l.unitPrice;
    const discount =
      l.discountType === 'PERCENTAGE'
        ? (subtotal * l.discountValue) / 100
        : l.discountType === 'FIXED'
          ? Math.min(
              subtotal,
              l.discountValue * (l.discountBasis === 'UNIT' ? l.quantity : 1),
            )
          : 0;
    return Math.round((subtotal - discount) * 100) / 100;
  }

  function patchLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  async function save(status: 'DRAFT' | 'SENT') {
    if (!session) return;
    if (lines.length === 0) {
      setError('Add at least one item to the quotation.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const common = {
        customerId: customerId || null,
        quotationDiscountType: orderDiscountType || undefined,
        quotationDiscountValue: orderDiscountType ? orderDiscountValue : undefined,
        validUntil: validUntil || undefined,
        notes: notes || undefined,
        termsAndConditions: terms || undefined,
        items,
      };
      let result: QuotationDetail;
      if (mode === 'edit' && initial) {
        result = await updateQuotation(session, initial.id, { ...common, clearQuotationDiscount: !orderDiscountType });
        if (status === 'SENT') {
          const { markQuotationSent } = await import('@/lib/quotations');
          result = await markQuotationSent(session, initial.id);
        }
      } else if (mode === 'revision' && initial) {
        result = await createRevision(session, initial.id, { ...common, changeReason: changeReason || undefined });
      } else {
        result = await createQuotation(session, { ...common, status });
      }
      router.push(`/quotations/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the quotation');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 lg:grid lg:h-full lg:grid-cols-[1.9fr_1fr] lg:gap-5">
      {/* Catalog + customer. min-w-0 lets this grid column shrink below its
          content's intrinsic width so the chip rows scroll internally instead
          of forcing the whole page to scroll horizontally. On lg+ the column
          is height-locked: the header/search/chips stay pinned and only the
          product grid below them scrolls. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-0.5 lg:[scrollbar-width:thin]">
        {header ? <div className="pb-3">{header}</div> : null}
        {/* Sticky control bar: search + category chips pin to the top of the
            scroll container; the page title above scrolls away with content. */}
        <div className="sticky top-0 z-10 space-y-3 bg-canvas pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="max-w-xs"
          >
            <option value="">Walk-in customer</option>
            {allCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ''}
              </option>
            ))}
          </Select>
          {canAddCustomer && (
            <Button
              variant="outline"
              size="icon"
              aria-label="Add customer"
              onClick={() => setQuickAddOpen(true)}
            >
              <UserPlus className="h-4 w-4" />
            </Button>
          )}
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products by name or SKU"
              className="pl-9"
            />
          </div>
        </div>

        {/* Category + subcategory chips — same as the POS section. */}
        <ChipRow activeKey={category} ariaLabel="categories">
          {categories.map((c) => (
            <button
              key={c}
              data-active={category === c}
              onClick={() => {
                setCategory(c);
                setSubcategory('All');
              }}
              className={cn(
                'h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors',
                category === c
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-border',
              )}
            >
              {c}
            </button>
          ))}
        </ChipRow>
        {subcategories.length > 0 ? (
          <ChipRow activeKey={subcategory} ariaLabel="subcategories">
            {subcategories.map((s) => (
              <button
                key={s}
                data-active={subcategory === s}
                onClick={() => setSubcategory(s)}
                className={cn(
                  'h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors',
                  subcategory === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-border',
                )}
              >
                {s}
              </button>
            ))}
          </ChipRow>
        ) : null}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2.5">
          {filteredProducts.slice(0, 120).map((p) => {
            const outOfStock = p.type === 'Inventory' && p.quantityOnHand <= 0;
            const lowStock =
              p.type === 'Inventory' &&
              !outOfStock &&
              p.reorderLevel != null &&
              p.quantityOnHand <= p.reorderLevel;
            return (
              <div
                key={p.id}
                title={p.name}
                className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-all hover:border-primary hover:shadow"
              >
                <button
                  type="button"
                  onClick={() => addProduct(p)}
                  disabled={outOfStock}
                  aria-label={`Add ${p.name} to quotation`}
                  className="relative block text-left disabled:cursor-not-allowed"
                >
                  <ProductImage
                    src={resolveImageUrl(p.imageUrl)}
                    alt={p.name}
                    rounded="rounded-none"
                    className={cn('aspect-[4/3] w-full border-0', outOfStock && 'opacity-60')}
                  />
                  {outOfStock ? (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      Out of Stock
                    </span>
                  ) : lowStock ? (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                      Low Stock
                    </span>
                  ) : null}
                </button>
                <div className="flex flex-1 flex-col p-2.5">
                  <div className="line-clamp-2 min-h-8 text-xs font-medium leading-tight">
                    {p.name}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {p.sku ?? ''}
                  </div>
                  <div className="mt-1.5 flex items-end justify-between gap-1">
                    <span className="text-sm font-semibold text-primary">
                      {formatMoney(p.unitPrice)}
                    </span>
                    <span
                      className={cn(
                        'text-[11px]',
                        outOfStock ? 'font-medium text-danger' : 'text-muted-foreground',
                      )}
                    >
                      {p.type !== 'Inventory'
                        ? p.type === 'Service'
                          ? 'Service'
                          : '—'
                        : outOfStock
                          ? 'Out'
                          : p.quantityOnHand.toLocaleString()}
                    </span>
                  </div>
                  <Button
                    variant={outOfStock ? 'outline' : 'primary'}
                    size="sm"
                    fullWidth
                    disabled={outOfStock}
                    className="mt-2"
                    onClick={() => addProduct(p)}
                    leftIcon={outOfStock ? undefined : <Plus className="h-4 w-4" />}
                  >
                    {outOfStock ? 'Out of Stock' : 'Add'}
                  </Button>
                </div>
              </div>
            );
          })}
          {filteredProducts.length === 0 && (
            <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
              No products match your search.
            </p>
          )}
        </div>
        </div>
      </div>

      {/* Quotation panel — spans the full content height on lg (it starts just
          below the app header, beside the catalog column); its middle section
          scrolls internally so the totals and actions always stay visible. */}
      <Card className="flex min-w-0 flex-col lg:h-full lg:min-h-0">
        <CardHeader className="shrink-0 border-b border-border p-4">
          <CardTitle className="text-base">
            {mode === 'revision' ? 'New revision' : mode === 'edit' ? 'Edit quotation' : 'New quotation'}
          </CardTitle>
        </CardHeader>

        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:[scrollbar-width:thin]">
        <CardContent className="space-y-2.5 p-3">
          {lines.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Add products to build the quotation.
            </p>
          )}
          {lines.map((l, index) => (
            <div key={l.key} className="rounded-xl border border-border p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{l.productName}</div>
                  {l.sku && <div className="truncate text-[11px] text-muted-foreground">{l.sku}</div>}
                </div>
                <button
                  onClick={() => removeLine(l.key)}
                  className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                  aria-label="Remove item"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {/* Qty (stepper, like the POS cart) + read-only unit price. */}
              <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] text-muted-foreground">Qty</div>
                  <div className="mt-0.5">
                    <QuantityStepper
                      quantity={l.quantity}
                      onDecrement={() =>
                        patchLine(l.key, { quantity: Math.max(1, l.quantity - 1) })
                      }
                      onIncrement={() => patchLine(l.key, { quantity: l.quantity + 1 })}
                      onSet={(qty) => patchLine(l.key, { quantity: qty })}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-muted-foreground">Unit price</div>
                  <div className="mt-0.5 h-9 text-sm font-semibold tabular-nums leading-9">
                    {formatMoney(l.unitPrice)}
                  </div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[11px] text-muted-foreground">
                  Discount
                  <Select
                    value={l.discountType}
                    onChange={(e) =>
                      patchLine(l.key, { discountType: e.target.value as DiscountType | '' })
                    }
                    className="mt-0.5 h-9"
                  >
                    <option value="">None</option>
                    <option value="PERCENTAGE">%</option>
                    <option value="FIXED">Rs.</option>
                  </Select>
                </label>
                <label className="text-[11px] text-muted-foreground">
                  {l.discountType === 'FIXED'
                    ? l.discountBasis === 'UNIT'
                      ? 'Off each unit'
                      : 'Off the line'
                    : 'Value'}
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    disabled={!l.discountType}
                    // Empty rather than a literal 0, so the field can be cleared
                    // and typed into. A numeric 0 bound straight to `value` snaps
                    // back the instant it is deleted, so the digit you type lands
                    // after it and reads as "05".
                    value={l.discountValue === 0 ? '' : l.discountValue}
                    placeholder="0"
                    onChange={(e) =>
                      patchLine(l.key, { discountValue: Number(e.target.value) || 0 })
                    }
                    className="mt-0.5 h-9"
                  />
                </label>
              </div>

              {/* A fixed amount can come off the line once or off every unit. A
                  percentage offers no such choice, being the same either way. */}
              {l.discountType === 'FIXED' ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(
                    [
                      ['LINE', 'Off the line'],
                      ['UNIT', 'Off each unit'],
                    ] as const
                  ).map(([b, label]) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => patchLine(l.key, { discountBasis: b })}
                      className={cn(
                        'rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors',
                        l.discountBasis === b
                          ? 'border-primary bg-brand-50 text-brand-700'
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              <Input
                value={l.itemNote}
                onChange={(e) => patchLine(l.key, { itemNote: e.target.value })}
                placeholder="Item note (optional)"
                className="mt-2 h-9 text-xs"
              />
              {/* Line total: qty x unit price, net of this line's discount. */}
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm">
                <span className="text-[11px] text-muted-foreground">
                  Total{l.quantity > 1 ? ` (${l.quantity} × ${formatMoney(l.unitPrice)})` : ''}
                  {l.discountType === 'FIXED' && l.discountBasis === 'UNIT' && l.discountValue > 0
                    ? ` less ${formatMoney(l.discountValue)} × ${l.quantity}`
                    : ''}
                </span>
                <span className="font-semibold tabular-nums text-primary">
                  {formatMoney(lineTotal(l, index))}
                </span>
              </div>
            </div>
          ))}
        </CardContent>

        <div className="space-y-2.5 border-t border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-muted-foreground">
              Order discount
              <Select
                value={orderDiscountType}
                onChange={(e) => setOrderDiscountType(e.target.value as DiscountType | '')}
                className="mt-0.5 h-9"
              >
                <option value="">None</option>
                <option value="PERCENTAGE">%</option>
                <option value="FIXED">Rs.</option>
              </Select>
            </label>
            <label className="text-[11px] text-muted-foreground">
              Value
              <Input
                type="number"
                min={0}
                step="any"
                disabled={!orderDiscountType}
                value={orderDiscountValue}
                onChange={(e) => setOrderDiscountValue(Number(e.target.value))}
                className="mt-0.5 h-9"
              />
            </label>
          </div>
          <label className="block text-[11px] text-muted-foreground">
            Valid until
            <Input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="mt-0.5 h-9"
            />
          </label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Quotation notes (optional)"
            className="min-h-14 text-xs"
          />
          <Textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            placeholder="Terms & conditions (optional)"
            className="min-h-14 text-xs"
          />
          {mode === 'revision' && (
            <Input
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder="Reason for this revision"
              className="h-9 text-xs"
            />
          )}
        </div>
        </div>

        {/* Pinned footer: totals + actions are always visible. */}
        <div className="shrink-0 space-y-2.5 border-t border-border p-3">
          <div className="space-y-1 rounded-xl bg-muted/60 p-3 text-sm">
            <Row label="Subtotal" value={formatMoney(preview?.subtotal ?? 0)} />
            {(preview?.productDiscountTotal ?? 0) > 0 && (
              <Row label="Product discounts" value={`- ${formatMoney(preview!.productDiscountTotal)}`} muted />
            )}
            {(preview?.quotationDiscountAmount ?? 0) > 0 && (
              <Row label="Order discount" value={`- ${formatMoney(preview!.quotationDiscountAmount)}`} muted />
            )}
            {(preview?.taxAmount ?? 0) > 0 && (
              <Row label="Tax / VAT" value={formatMoney(preview!.taxAmount)} />
            )}
            <div className="mt-1 flex items-center justify-between border-t border-border pt-1.5 text-base font-semibold">
              <span>Grand total</span>
              <span className="text-primary">{formatMoney(preview?.grandTotal ?? 0)}</span>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className={cn('grid gap-2', mode === 'create' ? 'grid-cols-2' : 'grid-cols-1')}>
            {mode === 'create' && (
              <Button variant="outline" disabled={submitting} onClick={() => save('DRAFT')}>
                Save draft
              </Button>
            )}
            <Button disabled={submitting} onClick={() => save(mode === 'create' ? 'SENT' : 'DRAFT')}>
              {mode === 'revision'
                ? 'Save revision'
                : mode === 'edit'
                  ? 'Save changes'
                  : 'Save & send'}
            </Button>
          </div>
        </div>
      </Card>

      <QuickAddCustomerDialog
        open={quickAddOpen}
        session={session}
        onClose={() => setQuickAddOpen(false)}
        onCreated={(customer) => {
          setAddedCustomers((prev) => [customer, ...prev]);
          setCustomerId(customer.id);
          setQuickAddOpen(false);
        }}
      />
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={muted ? 'text-muted-foreground' : ''}>{value}</span>
    </div>
  );
}
