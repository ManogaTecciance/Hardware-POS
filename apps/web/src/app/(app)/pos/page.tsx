'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  NotebookPen,
  Plus,
  Search,
  ShieldCheck,
  ShoppingCart,
  Tag,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';

import { CustomerCombobox } from '@/components/pos/customer-combobox';
import { QuantityStepper } from '@/components/pos/quantity-stepper';
import { ItemDiscountDialog } from '@/components/pos/item-discount-dialog';
import { ItemNoteDialog } from '@/components/pos/item-note-dialog';
import { ManagerApprovalDialog } from '@/components/pos/manager-approval-dialog';
import { OrderDiscountDialog } from '@/components/pos/order-discount-dialog';
import { QuickAddCustomerDialog } from '@/components/pos/quick-add-customer-dialog';
import { ProductImage } from '@/components/product-image';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { computeLine, computeTotals, type LineDiscount, type OrderDiscount } from '@/lib/cart';
import { useCheckoutData, type ClientProduct } from '@/lib/catalog';
import { ORDER_DISCOUNT_KEY, requestDiscountApproval } from '@/lib/discounts';
import { resolveImageUrl } from '@/lib/products-api';
import { Permission, discountLimitFor, withinDiscountLimit } from '@/lib/permissions';
import { stockCap, usePosCart } from '@/lib/pos-cart';
import { scanCandidates, useBarcodeScanner } from '@/lib/use-barcode-scanner';
import { cn, formatMoney, round2 } from '@/lib/utils';

const PAGE_SIZES = [20, 30, 40, 50];
interface PendingLineApproval {
  productId: string;
  discount: LineDiscount;
  percent: number;
}

/** Toast intent — drives the semantic colours (never raw hex). */
type ToastTone = 'success' | 'warning' | 'danger';

export default function PosPage() {
  const { session, hasPermission } = useAuth();
  const router = useRouter();
  const data = useCheckoutData(session!);
  const cart = usePosCart();
  const canAddCustomer = hasPermission(Permission.CUSTOMER_MANAGE);
  const canViewSales = hasPermission(Permission.SALE_READ);
  const canQuote = hasPermission(Permission.QUOTATION_READ);

  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('All');
  const [subcategory, setSubcategory] = React.useState('All');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [noteFor, setNoteFor] = React.useState<string | null>(null);
  const [discountFor, setDiscountFor] = React.useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = React.useState<PendingLineApproval | null>(null);
  const [orderDiscountOpen, setOrderDiscountOpen] = React.useState(false);
  const [pendingOrderApproval, setPendingOrderApproval] = React.useState<{
    discount: OrderDiscount;
    percent: number;
  } | null>(null);
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const [toast, setToast] = React.useState<{ message: string; tone: ToastTone } | null>(null);
  const toastTimer = React.useRef<number | undefined>(undefined);
  // Portrait / phone: the cart lives in a slide-up sheet instead of a fixed column.
  const [cartOpen, setCartOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  /**
   * Transient confirmation at the bottom of the screen. Rapid scans replace the
   * previous message, so the pending dismissal is cleared first — otherwise an
   * earlier timer would cut the newest toast short.
   */
  const showToast = (message: string, tone: ToastTone = 'success') => {
    setToast({ message, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  React.useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Keep the cart's product snapshots aligned with each fresh catalog load,
  // so stock warnings reflect sales made on other registers.
  React.useEffect(() => {
    if (!data.loading && !data.error) cart.refreshProducts(data.products);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.products, data.loading, data.error]);

  // ── catalog filtering + pagination ─────────────────────────────────────────
  const categories = ['All', ...data.categories];
  const activeCategory = data.categoryTree.find((c) => c.name === category);
  const subcategories =
    category !== 'All' && activeCategory && activeCategory.subcategories.length > 0
      ? ['All', ...activeCategory.subcategories.map((s) => s.name)]
      : [];
  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      data.products.filter((p) => {
        const matchesCat = category === 'All' || p.categoryName === category;
        const matchesSub = subcategory === 'All' || p.subcategoryName === subcategory;
        const matchesQuery =
          !q || p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q);
        return matchesCat && matchesSub && matchesQuery;
      }),
    [data.products, category, subcategory, q],
  );

  React.useEffect(() => setPage(1), [q, category, subcategory, pageSize]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageProducts = filtered.slice((page - 1) * pageSize, page * pageSize);

  const addToCart = (product: ClientProduct) => {
    cart.addToCart(product);
    showToast(`${product.name} added`);
  };

  /**
   * Resolve a scanned / typed code to a product. Matches SKU across the WHOLE
   * catalog, not the filtered page — a scan must work regardless of which
   * category tab or search term is active. QR payloads that wrap the code in a
   * URL or JSON are unwrapped by `scanCandidates`, so both 1D barcodes and QR
   * codes resolve through the same path.
   */
  const findBySku = React.useCallback(
    (code: string): ClientProduct | undefined => {
      for (const candidate of scanCandidates(code)) {
        const key = candidate.toLowerCase();
        const hit = data.products.find((p) => (p.sku ?? '').trim().toLowerCase() === key);
        if (hit) return hit;
      }
      return undefined;
    },
    [data.products],
  );

  /** Add a scanned product, or explain why it couldn't be added. */
  const addByCode = React.useCallback(
    (code: string) => {
      const product = findBySku(code);
      if (!product) {
        showToast(`No product found for "${code}"`, 'danger');
        return;
      }
      if (product.type === 'Inventory' && product.quantityOnHand <= 0) {
        showToast(`${product.name} is out of stock`, 'warning');
        return;
      }
      cart.addToCart(product);
      showToast(`${product.name} added`);
      setQuery('');
    },
    // showToast/cart are stable enough for this handler's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findBySku],
  );

  // Hardware scanner works anywhere on the page — no need to focus the search
  // box first. Suspended while a modal is open so scans can't fire behind it.
  const modalOpen =
    !!noteFor ||
    !!discountFor ||
    !!pendingApproval ||
    orderDiscountOpen ||
    !!pendingOrderApproval ||
    quickAddOpen;
  useBarcodeScanner({ onScan: addByCode, enabled: !modalOpen });

  // Enter adds an exact SKU match (whole catalog), else the sole visible result.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const exact = findBySku(q);
    const target = exact ?? (filtered.length === 1 ? filtered[0] : undefined);
    if (target) {
      addToCart(target);
      setQuery('');
    }
  };

  // ── discounts ──────────────────────────────────────────────────────────────
  const handleLineDiscountApply = (productId: string, discount: LineDiscount) => {
    const item = cart.items.find((it) => it.product.id === productId);
    if (!item) return;
    const line = computeLine({ ...item, discount });
    const percent = line.lineSubtotal > 0 ? (line.discountAmount / line.lineSubtotal) * 100 : 0;
    if (withinDiscountLimit(discountLimitFor(session!.user.role), percent)) {
      cart.setLineDiscount(productId, discount);
      setDiscountFor(null);
    } else {
      setPendingApproval({ productId, discount, percent });
      setDiscountFor(null);
    }
  };

  const handleApproveLine = async (managerPin: string, note: string): Promise<string | null> => {
    if (!pendingApproval) return 'No pending discount';
    const { productId, discount } = pendingApproval;
    const res = await requestDiscountApproval(session!, {
      managerPin,
      productId,
      discountType: discount.type,
      discountValue: discount.value,
      reason: note || discount.reason,
    });
    if (res.approved && res.approvalToken) {
      cart.setLineDiscount(
        productId,
        { ...discount, reason: note || discount.reason },
        res.approvalToken,
        res.approvedByUserId ?? undefined,
      );
      setPendingApproval(null);
      showToast('Discount approved by manager');
      return null;
    }
    return res.reason ?? 'Not approved';
  };

  const totals = computeTotals(cart.items, data.settings.taxRatePercent, cart.orderDiscount);
  const orderBase = round2(totals.subtotal - totals.totalDiscount);

  const handleOrderDiscountApply = (discount: OrderDiscount) => {
    const amount =
      discount.type === 'PERCENTAGE'
        ? round2((orderBase * discount.value) / 100)
        : Math.min(orderBase, round2(discount.value));
    const percent = orderBase > 0 ? (amount / orderBase) * 100 : 0;
    if (withinDiscountLimit(discountLimitFor(session!.user.role), percent)) {
      cart.setOrderDiscount(discount);
      setOrderDiscountOpen(false);
    } else {
      setPendingOrderApproval({ discount, percent });
      setOrderDiscountOpen(false);
    }
  };

  const handleApproveOrder = async (managerPin: string, note: string): Promise<string | null> => {
    if (!pendingOrderApproval) return 'No pending discount';
    const { discount } = pendingOrderApproval;
    const res = await requestDiscountApproval(session!, {
      managerPin,
      productId: ORDER_DISCOUNT_KEY,
      discountType: discount.type,
      discountValue: discount.value,
      reason: note || discount.reason,
    });
    if (res.approved && res.approvalToken) {
      cart.setOrderDiscount({ ...discount, reason: note || discount.reason }, res.approvalToken);
      setPendingOrderApproval(null);
      showToast('Order discount approved by manager');
      return null;
    }
    return res.reason ?? 'Not approved';
  };

  // Every picked customer passes through cart.addCustomer, so the name of the
  // current selection is always resolvable from the cart's own list.
  const selectedCustomerName =
    cart.addedCustomers.find((c) => c.id === cart.customerId)?.name ?? null;

  const noteItem = cart.items.find((it) => it.product.id === noteFor);
  const discountItem = cart.items.find((it) => it.product.id === discountFor);
  const approvalItem = cart.items.find((it) => it.product.id === pendingApproval?.productId);

  const currency = data.settings.currency;
  const cartEmpty = cart.items.length === 0;
  const canPay = !cartEmpty && !totals.hasStockIssue;

  const goToPayment = () => {
    setCartOpen(false);
    router.push('/pos/payment');
  };

  // ── cart panel ───────────────────────────────────────────────────────────
  // Rendered in two homes: the fixed right column (lg+) and the portrait/phone
  // slide-up sheet. Kept as a function (not a nested component) so both homes
  // stay in the DOM without remounting the customer picker on every render.
  const renderCartPanel = (inSheet: boolean) => (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — never scrolls */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShoppingCart className="h-4 w-4 text-primary" />
          Cart
          {totals.itemCount > 0 ? (
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
              {totals.itemCount} item{totals.itemCount > 1 ? 's' : ''}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {!cartEmpty ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-danger hover:bg-danger-soft hover:text-danger"
              onClick={() => {
                if (window.confirm('Clear all items from the cart?')) cart.clearCart();
              }}
            >
              Clear
            </Button>
          ) : null}
          {inSheet ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Close cart"
              onClick={() => setCartOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Customer — never scrolls */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <CustomerCombobox
          session={session!}
          customerId={cart.customerId}
          customerName={selectedCustomerName}
          onSelect={(customer) => (customer ? cart.addCustomer(customer) : cart.setCustomerId(''))}
        />
        {canAddCustomer ? (
          <Button
            variant="outline"
            size="icon"
            aria-label="Add customer"
            onClick={() => setQuickAddOpen(true)}
          >
            <UserPlus className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {/* Items — the only scroll region inside the cart */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {cartEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <ShoppingCart className="h-8 w-8 text-muted-foreground/40" />
            Tap a product to add it to the cart.
          </div>
        ) : (
          cart.items.map((item) => {
            const line = computeLine(item);
            return (
              <div key={item.product.id} className="rounded-xl border border-border bg-card p-2.5">
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium leading-tight">
                      {item.product.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {item.product.sku ?? '—'} · {formatMoney(item.product.unitPrice, currency)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">
                      {formatMoney(line.lineTotal, currency)}
                    </div>
                    {line.discountAmount > 0 ? (
                      <div className="flex items-center justify-end gap-1 text-[11px] font-medium text-success">
                        {item.approvalToken ? (
                          <ShieldCheck className="h-3 w-3" aria-label="Manager approved" />
                        ) : null}
                        -{formatMoney(line.discountAmount, currency)}
                      </div>
                    ) : null}
                  </div>
                </div>

                {line.outOfStock ? (
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-danger">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Only {item.product.quantityOnHand} in stock
                  </div>
                ) : null}

                {item.note ? (
                  <div className="mt-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                    {item.note}
                  </div>
                ) : null}

                <div className="mt-2 flex items-center justify-between">
                  <QuantityStepper
                    quantity={item.quantity}
                    max={stockCap(item.product) ?? undefined}
                    onDecrement={() => cart.changeQty(item.product.id, -1)}
                    onIncrement={() => cart.changeQty(item.product.id, 1)}
                    onSet={(q) => cart.setQty(item.product.id, q)}
                  />

                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('h-9 w-9', item.note && 'text-primary')}
                      onClick={() => setNoteFor(item.product.id)}
                      aria-label="Add note"
                    >
                      <NotebookPen className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('h-9 w-9', item.discount && 'text-primary')}
                      onClick={() => setDiscountFor(item.product.id)}
                      aria-label="Add product discount"
                    >
                      <Tag className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-danger"
                      aria-label="Remove item"
                      onClick={() => cart.removeItem(item.product.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Summary + payment — never scrolls, always visible */}
      <div className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-3 text-sm">
        <Row label="Subtotal" value={formatMoney(totals.subtotal, currency)} />
        {totals.totalDiscount > 0 ? (
          <Row
            label="Product Discount"
            value={`- ${formatMoney(totals.totalDiscount, currency)}`}
            accent="success"
          />
        ) : null}
        <button
          type="button"
          disabled={cartEmpty}
          onClick={() => setOrderDiscountOpen(true)}
          className={cn(
            'flex w-full items-center rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            cart.orderDiscount
              ? 'justify-between border-border bg-muted/40 hover:border-primary'
              : 'justify-center gap-1.5 border-dashed border-primary/50 text-primary hover:bg-brand-50',
          )}
        >
          {cart.orderDiscount ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <Tag className="h-4 w-4" />
                Order discount
                {cart.orderApprovalToken ? (
                  <ShieldCheck className="h-4 w-4 text-success" aria-label="Manager approved" />
                ) : null}
              </span>
              <span className="font-semibold text-success">
                -{formatMoney(totals.orderDiscountAmount, currency)}
              </span>
            </>
          ) : (
            <>
              <Tag className="h-4 w-4" />
              Add order discount
            </>
          )}
        </button>
        <Row
          label={`VAT (${data.settings.taxRatePercent}%)`}
          value={formatMoney(totals.taxAmount, currency)}
        />
        <div className="flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-base font-semibold">Grand Total</span>
          <span className="text-lg font-bold tabular-nums text-primary">
            {formatMoney(totals.total, currency)}
          </span>
        </div>

        {totals.hasStockIssue ? (
          <div className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
            <AlertTriangle className="h-3.5 w-3.5" />
            Some items exceed available stock.
          </div>
        ) : null}

        <Button
          size="lg"
          fullWidth
          className="mt-1 h-14 justify-between px-5 text-base"
          disabled={!canPay}
          onClick={goToPayment}
        >
          <span>
            <span className="hidden xl:inline">Proceed to Payment</span>
            <span className="xl:hidden">Payment</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate tabular-nums">{formatMoney(totals.total, currency)}</span>
            <ArrowRight className="h-5 w-5 shrink-0" />
          </span>
        </Button>

        {/* Functional secondary actions only — Hold/Reserve have no backing
            feature in this app, so they are intentionally not shown. */}
        {(canViewSales || canQuote) && !cartEmpty ? (
          <div className="grid grid-cols-2 gap-2">
            {canViewSales ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/sales')}
                leftIcon={<Clock className="h-4 w-4" />}
              >
                Recent Sales
              </Button>
            ) : null}
            {canQuote ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/quotations/new')}
                leftIcon={<FileText className="h-4 w-4" />}
              >
                Quote
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_400px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
      {/* ── Catalog ─────────────────────────────────────────────── */}
      {/* min-w-0 lets this grid/flex child shrink below its content width so
          the product grid never blows out the track and steals the cart's
          column (the classic CSS grid `min-width:auto` overflow trap). */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col lg:min-h-0">
        {/* Sticky control bar — search, scan, categories. Never scrolls. */}
        <div className="shrink-0 space-y-2.5 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search products…"
                className="h-11 pl-10 pr-9"
                aria-label="Search products"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>

          {data.error ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Couldn&apos;t load the product catalog: {data.error}
              </span>
              <Button variant="outline" size="sm" onClick={data.reload}>
                Retry
              </Button>
            </div>
          ) : null}

          {/* Single-line chip rows: constant height however many categories
              exist; edge fades + chevrons signal and reach off-screen chips. */}
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

        {/* Independent product scroll region */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 pr-0.5 [scrollbar-width:thin]">
          {data.loading ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Loading products…</p>
          ) : filtered.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No products match your search.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2.5">
              {pageProducts.map((p) => {
                const outOfStock = p.type === 'Inventory' && p.quantityOnHand <= 0;
                // Low stock only when a reorder point is set and stock is at/below
                // it — the same rule the products table and dashboard alert use.
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
                      onClick={() => addToCart(p)}
                      disabled={outOfStock}
                      aria-label={`Add ${p.name} to cart`}
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
                          {formatMoney(p.unitPrice, currency)}
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
                        onClick={() => addToCart(p)}
                        leftIcon={outOfStock ? undefined : <Plus className="h-4 w-4" />}
                      >
                        {outOfStock ? 'Out of Stock' : 'Add'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination footer — stays pinned below the scroll region */}
        {!data.loading && filtered.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border pt-2.5 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="hidden md:inline">
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)} of{' '}
                {filtered.length.toLocaleString()} products
              </span>
              <span className="hidden sm:inline md:hidden">Per page</span>
              <Select
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="w-auto"
                aria-label="Products per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="px-2 tabular-nums text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Fixed cart column (landscape tablet + desktop) ───────── */}
      <aside className="hidden min-h-0 min-w-0 lg:flex">
        <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden">
          {renderCartPanel(false)}
        </Card>
      </aside>

      {/* ── Portrait / phone: persistent cart bar + slide-up sheet ─ */}
      <div className="shrink-0 lg:hidden">
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm active:bg-muted"
        >
          <span className="flex items-center gap-2.5 text-sm font-semibold">
            <span className="relative">
              <ShoppingCart className="h-5 w-5 text-primary" />
              {totals.itemCount > 0 ? (
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {totals.itemCount}
                </span>
              ) : null}
            </span>
            {cartEmpty
              ? 'Cart is empty'
              : `View cart · ${totals.itemCount} item${totals.itemCount > 1 ? 's' : ''}`}
          </span>
          <span className="text-base font-semibold tabular-nums">
            {formatMoney(totals.total, currency)}
          </span>
        </button>
      </div>

      {cartOpen ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Cart"
        >
          <button
            type="button"
            aria-label="Close cart"
            onClick={() => setCartOpen(false)}
            className="absolute inset-0 bg-slate-900/40"
          />
          <div className="absolute inset-x-0 bottom-0 flex h-[88dvh] flex-col overflow-hidden rounded-t-2xl bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl">
            {renderCartPanel(true)}
          </div>
        </div>
      ) : null}

      {/* ── Dialogs ─────────────────────────────────────────────── */}
      {noteItem ? (
        <ItemNoteDialog
          open={!!noteFor}
          productName={noteItem.product.name}
          initialNote={noteItem.note}
          onSave={(note) => {
            cart.setNote(noteItem.product.id, note);
            setNoteFor(null);
          }}
          onClose={() => setNoteFor(null)}
        />
      ) : null}

      {discountItem ? (
        <ItemDiscountDialog
          open={!!discountFor}
          productName={discountItem.product.name}
          unitPrice={discountItem.product.unitPrice}
          quantity={discountItem.quantity}
          currency={currency}
          roleLimit={discountLimitFor(session!.user.role)}
          initial={discountItem.discount}
          onApply={(d) => handleLineDiscountApply(discountItem.product.id, d)}
          onClear={() => {
            cart.setLineDiscount(discountItem.product.id, undefined);
            setDiscountFor(null);
          }}
          onClose={() => setDiscountFor(null)}
        />
      ) : null}

      {approvalItem && pendingApproval ? (
        <ManagerApprovalDialog
          open={!!pendingApproval}
          productName={approvalItem.product.name}
          discountLabel={formatDiscountLabel(pendingApproval.discount, currency)}
          onApprove={handleApproveLine}
          onClose={() => setPendingApproval(null)}
        />
      ) : null}

      <OrderDiscountDialog
        open={orderDiscountOpen}
        baseAmount={orderBase}
        currency={currency}
        roleLimit={discountLimitFor(session!.user.role)}
        initial={cart.orderDiscount}
        onApply={handleOrderDiscountApply}
        onClear={() => {
          cart.setOrderDiscount(undefined);
          setOrderDiscountOpen(false);
        }}
        onClose={() => setOrderDiscountOpen(false)}
      />

      {pendingOrderApproval ? (
        <ManagerApprovalDialog
          open={!!pendingOrderApproval}
          productName="Order discount"
          discountLabel={formatDiscountLabel(pendingOrderApproval.discount, currency)}
          onApprove={handleApproveOrder}
          onClose={() => setPendingOrderApproval(null)}
        />
      ) : null}

      {canAddCustomer ? (
        <QuickAddCustomerDialog
          open={quickAddOpen}
          session={session!}
          onClose={() => setQuickAddOpen(false)}
          onCreated={(customer) => {
            cart.addCustomer({ id: customer.id, name: customer.name });
            setQuickAddOpen(false);
            showToast(`Customer "${customer.name}" added`);
          }}
        />
      ) : null}

      {toast ? (
        /* High-contrast surface in both themes (a soft tint + tinted text fell
           below the WCAG AA 4.5:1 minimum in light mode). Tone is carried by
           the icon and left accent, never by colour alone — WCAG 1.4.1. */
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-l-4 border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground shadow-pop',
            toast.tone === 'success' && 'border-l-success',
            toast.tone === 'warning' && 'border-l-warning',
            toast.tone === 'danger' && 'border-l-danger',
          )}
        >
          {toast.tone === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
          ) : toast.tone === 'warning' ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <X className="h-4 w-4 shrink-0 text-danger" aria-hidden />
          )}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: 'success' }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span
        className={cn('tabular-nums', accent === 'success' ? 'text-success' : 'text-foreground')}
      >
        {value}
      </span>
    </div>
  );
}

function formatDiscountLabel(discount: LineDiscount | OrderDiscount, currency: string): string {
  return discount.type === 'PERCENTAGE'
    ? `${discount.value}% off`
    : `${formatMoney(discount.value, currency)} off`;
}
