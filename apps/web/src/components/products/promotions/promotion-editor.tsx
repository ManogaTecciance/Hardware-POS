'use client';

import {
  Check,
  Layers,
  Loader2,
  Percent,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { ProductSelectorDialog } from '@/components/restaurant/menu/item-add/product-selector-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Toast } from '@/components/ui/toast';
import { type Session } from '@/lib/auth';
import { fetchBranches, type BranchSummary } from '@/lib/products/branches-api';
import {
  createPromotion,
  fetchPromotion,
  labelForPromotionType,
  PROMOTION_CHANNELS,
  PROMOTION_DAYS_OF_WEEK,
  updatePromotion,
  type Promotion,
  type PromotionChannel,
  type PromotionDayOfWeek,
  type PromotionItem,
  type PromotionType,
} from '@/lib/products/promotions-api';
import { type ManagedProduct } from '@/lib/products-api';

/**
 * Promotion editor (D45 — Promotions admin).
 *
 * Handles Create and Edit against a single component. Deliberate limits:
 *
 * - **Type is immutable after create.** The segmented control is disabled in
 *   edit mode; a Bundle cannot become a Percentage without redoing the item
 *   roles, and the backend enforces the same. Kept as a hard disable rather
 *   than a warning so the operator can't burn a save on a rejected PATCH.
 * - **Type shapes the fields.** Bundle asks for a fixed price; BOGO wants a
 *   Buy + Get pair plus percentage-off; the two discount kinds share one item
 *   picker + a rate or amount. Fields that don't apply to the current type
 *   don't render — the wizard's server-side validator refuses stray fields
 *   too, but the UI never asks for them.
 * - **Cancel confirms when dirty.** The comparator diffs against the initial
 *   snapshot rather than against the last save, so an operator who typed then
 *   deleted is not warned.
 */
interface Props {
  session: Session;
  /** Editing an existing promotion when set. Determines create vs. patch. */
  promotionId?: string;
  /**
   * Optional pre-loaded initial promotion — used by the Edit route so the
   * shell can gate on existence before mounting the editor.
   */
  initialPromotion?: Promotion;
  /** After a successful save, navigate back to this route. Defaults to list. */
  successHref?: string;
}

const DAY_LABELS: Record<PromotionDayOfWeek, string> = {
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
};

const CHANNEL_LABELS: Record<PromotionChannel, string> = {
  DINE_IN: 'Dine-in',
  TAKEAWAY: 'Takeaway',
  ONLINE: 'Online',
};

interface EditorState {
  name: string;
  description: string;
  type: PromotionType;
  fixedPrice: string;
  percentageOff: string;
  amountOff: string;
  buyQuantity: string;
  getQuantity: string;
  startsOn: string;
  endsOn: string;
  daysOfWeek: PromotionDayOfWeek[];
  startTime: string;
  endTime: string;
  branchScope: string[];
  channelScope: PromotionChannel[];
  stackable: boolean;
  items: Array<{ productId: string; role: PromotionItem['role']; quantity: string; name?: string }>;
}

function emptyState(type: PromotionType = 'BUNDLE_FIXED_PRICE'): EditorState {
  return {
    name: '',
    description: '',
    type,
    fixedPrice: '',
    percentageOff: '',
    amountOff: '',
    buyQuantity: '1',
    getQuantity: '1',
    startsOn: '',
    endsOn: '',
    daysOfWeek: [],
    startTime: '',
    endTime: '',
    branchScope: [],
    channelScope: [],
    stackable: false,
    items: [],
  };
}

function fromPromotion(p: Promotion): EditorState {
  return {
    name: p.name,
    description: p.description ?? '',
    type: p.type,
    fixedPrice: p.fixedPrice != null ? String(p.fixedPrice) : '',
    percentageOff: p.percentageOff != null ? String(p.percentageOff) : '',
    amountOff: p.amountOff != null ? String(p.amountOff) : '',
    buyQuantity: p.buyQuantity != null ? String(p.buyQuantity) : '1',
    getQuantity: p.getQuantity != null ? String(p.getQuantity) : '1',
    startsOn: p.startsOn?.slice(0, 10) ?? '',
    endsOn: p.endsOn?.slice(0, 10) ?? '',
    daysOfWeek: p.daysOfWeek,
    startTime: p.startTime ?? '',
    endTime: p.endTime ?? '',
    branchScope: p.branchScope,
    channelScope: p.channelScope,
    stackable: p.stackable,
    items: p.items.map((i) => ({
      productId: i.productId,
      role: i.role,
      quantity: String(i.quantity ?? 1),
    })),
  };
}

export function PromotionEditor({
  session,
  promotionId,
  initialPromotion,
  successHref = '/products/promotions',
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const linkProductId = searchParams?.get('linkProductId') ?? null;
  const isEdit = !!promotionId;

  const [state, setState] = React.useState<EditorState>(() =>
    initialPromotion ? fromPromotion(initialPromotion) : emptyState(),
  );
  const initialSnapshotRef = React.useRef<string>(
    JSON.stringify(initialPromotion ? fromPromotion(initialPromotion) : emptyState()),
  );

  const [branches, setBranches] = React.useState<BranchSummary[]>([]);
  const [loading, setLoading] = React.useState(isEdit && !initialPromotion);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [productPickerOpen, setProductPickerOpen] = React.useState(false);
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved'>('idle');

  // Fetch branches for the branch-scope multi-select.
  React.useEffect(() => {
    fetchBranches(session)
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [session]);

  // Fetch promotion on edit route when the page didn't pre-load it.
  React.useEffect(() => {
    if (!promotionId || initialPromotion) return;
    let cancelled = false;
    setLoading(true);
    fetchPromotion(session, promotionId)
      .then((p) => {
        if (cancelled) return;
        const snapshot = fromPromotion(p);
        setState(snapshot);
        initialSnapshotRef.current = JSON.stringify(snapshot);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load promotion');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, promotionId, initialPromotion]);

  // Preselect the product from ?linkProductId= on the create route only —
  // in edit mode the items list is already populated.
  React.useEffect(() => {
    if (isEdit || !linkProductId) return;
    setState((prev) => {
      if (prev.items.some((i) => i.productId === linkProductId)) return prev;
      return {
        ...prev,
        items: [
          ...prev.items,
          {
            productId: linkProductId,
            role: prev.type === 'BUNDLE_FIXED_PRICE' ? 'BUNDLE' : 'BUY',
            quantity: '1',
          },
        ],
      };
    });
    // Intentionally run once on mount — the query string is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = React.useCallback((p: Partial<EditorState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const dirty = React.useMemo(
    () => JSON.stringify(state) !== initialSnapshotRef.current,
    [state],
  );

  const toggleDay = (d: PromotionDayOfWeek) => {
    setState((prev) => ({
      ...prev,
      daysOfWeek: prev.daysOfWeek.includes(d)
        ? prev.daysOfWeek.filter((x) => x !== d)
        : [...prev.daysOfWeek, d],
    }));
  };

  const toggleChannel = (c: PromotionChannel) => {
    setState((prev) => ({
      ...prev,
      channelScope: prev.channelScope.includes(c)
        ? prev.channelScope.filter((x) => x !== c)
        : [...prev.channelScope, c],
    }));
  };

  const toggleBranch = (id: string) => {
    setState((prev) => ({
      ...prev,
      branchScope: prev.branchScope.includes(id)
        ? prev.branchScope.filter((x) => x !== id)
        : [...prev.branchScope, id],
    }));
  };

  const addProduct = (product: ManagedProduct) => {
    setState((prev) => {
      if (prev.items.some((i) => i.productId === product.id)) return prev;
      // Role heuristic: BOGO always adds as BUY (the reward is configured
      // separately); Bundle adds as BUNDLE; discounts add as BUY.
      const role: PromotionItem['role'] = prev.type === 'BUNDLE_FIXED_PRICE' ? 'BUNDLE' : 'BUY';
      return {
        ...prev,
        items: [...prev.items, { productId: product.id, role, quantity: '1', name: product.name }],
      };
    });
    setProductPickerOpen(false);
  };

  const removeProduct = (productId: string) => {
    setState((prev) => ({ ...prev, items: prev.items.filter((i) => i.productId !== productId) }));
  };

  const changeItemQuantity = (productId: string, quantity: string) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((i) => (i.productId === productId ? { ...i, quantity } : i)),
    }));
  };

  const changeItemRole = (productId: string, role: PromotionItem['role']) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((i) => (i.productId === productId ? { ...i, role } : i)),
    }));
  };

  const validate = (): string | null => {
    if (!state.name.trim()) return 'Give the promotion a name.';
    if (state.items.length === 0) return 'Add at least one product.';
    if (state.type === 'BUNDLE_FIXED_PRICE' && !state.fixedPrice) {
      return 'Bundle promotions need a fixed price.';
    }
    if (state.type === 'PERCENTAGE_DISCOUNT' && !state.percentageOff) {
      return 'Set the percentage off.';
    }
    if (state.type === 'BUY_X_GET_Y' && !state.percentageOff) {
      // 100 = free — but the field is still required so "free reward" is explicit.
      return 'Set the discount on the Get item (100 = free).';
    }
    if (state.type === 'FIXED_AMOUNT_DISCOUNT' && !state.amountOff) {
      return 'Set the amount off.';
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSaving(true);
    setSaveState('saving');

    const commonPayload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      fixedPrice:
        state.type === 'BUNDLE_FIXED_PRICE' && state.fixedPrice ? Number(state.fixedPrice) : null,
      percentageOff:
        state.type === 'PERCENTAGE_DISCOUNT' || state.type === 'BUY_X_GET_Y'
          ? state.percentageOff
            ? Number(state.percentageOff)
            : null
          : null,
      amountOff:
        state.type === 'FIXED_AMOUNT_DISCOUNT' && state.amountOff ? Number(state.amountOff) : null,
      buyQuantity: state.type === 'BUY_X_GET_Y' ? Number(state.buyQuantity) || 1 : null,
      getQuantity: state.type === 'BUY_X_GET_Y' ? Number(state.getQuantity) || 1 : null,
      startsOn: state.startsOn || null,
      endsOn: state.endsOn || null,
      daysOfWeek: state.daysOfWeek,
      startTime: state.startTime || null,
      endTime: state.endTime || null,
      branchScope: state.branchScope,
      channelScope: state.channelScope,
      stackable: state.stackable,
      items: state.items.map((i) => ({
        productId: i.productId,
        role: i.role,
        quantity: Number(i.quantity) || 1,
      })),
    };

    try {
      if (isEdit && promotionId) {
        await updatePromotion(session, promotionId, commonPayload);
        setToast('Promotion updated.');
      } else {
        await createPromotion(session, { ...commonPayload, type: state.type });
        setToast('Promotion created.');
      }
      setSaveState('saved');
      initialSnapshotRef.current = JSON.stringify(state);
      setTimeout(() => router.push(successHref), 400);
    } catch (err) {
      setSaving(false);
      setSaveState('idle');
      setError(err instanceof Error ? err.message : 'Could not save promotion');
    }
  };

  const cancel = () => {
    if (dirty) setConfirmCancel(true);
    else router.push(successHref);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
        Loading promotion…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Basics — name, description, type */}
      <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">Basics</h2>
          <p className="text-xs text-muted-foreground">Name, description, and promotion type.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="promo-name">
            Name<span className="text-danger" aria-hidden="true">*</span>
          </label>
          <Input
            id="promo-name"
            value={state.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Lunch Bundle"
            maxLength={120}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="promo-desc">
            Description
          </label>
          <Textarea
            id="promo-desc"
            value={state.description}
            onChange={(e) => patch({ description: e.target.value.slice(0, 400) })}
            placeholder="Optional — shown in reports and receipts."
            className="min-h-[80px]"
          />
        </div>

        <div>
          <span className="text-sm font-medium">Type</span>
          <p className="text-[11px] text-muted-foreground">
            {isEdit
              ? 'Type is fixed once created — the item roles a promotion carries depend on it.'
              : 'Pick the shape that matches how the discount should be applied.'}
          </p>
          <div role="radiogroup" aria-label="Promotion type" className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
            {(
              [
                { value: 'BUNDLE_FIXED_PRICE', label: 'Bundle', icon: <Layers className="h-4 w-4" /> },
                { value: 'BUY_X_GET_Y', label: 'Buy X, Get Y', icon: <Sparkles className="h-4 w-4" /> },
                { value: 'PERCENTAGE_DISCOUNT', label: 'Percentage', icon: <Percent className="h-4 w-4" /> },
                { value: 'FIXED_AMOUNT_DISCOUNT', label: 'Amount off', icon: <span className="text-xs font-bold">LKR</span> },
              ] as { value: PromotionType; label: string; icon: React.ReactNode }[]
            ).map((t) => {
              const selected = state.type === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={isEdit}
                  onClick={() => patch({ type: t.value })}
                  className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-medium transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30'
                      : 'border-border bg-surface hover:border-primary hover:bg-brand-100'
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Type-specific fields */}
      <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">{labelForPromotionType(state.type)}</h2>
          <p className="text-xs text-muted-foreground">
            Fields specific to this promotion type.
          </p>
        </div>

        {state.type === 'BUNDLE_FIXED_PRICE' ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-fixed">
              Fixed price<span className="text-danger" aria-hidden="true">*</span>
            </label>
            <MoneyInput
              id="promo-fixed"
              value={state.fixedPrice}
              onChange={(v) => patch({ fixedPrice: v })}
            />
            <p className="text-[11px] text-muted-foreground">
              Total price the operator charges for the whole bundle.
            </p>
          </div>
        ) : null}

        {state.type === 'BUY_X_GET_Y' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="promo-buy-qty">
                Buy quantity
              </label>
              <Input
                id="promo-buy-qty"
                type="number"
                inputMode="numeric"
                min={1}
                value={state.buyQuantity}
                onChange={(e) => patch({ buyQuantity: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="promo-get-qty">
                Get quantity
              </label>
              <Input
                id="promo-get-qty"
                type="number"
                inputMode="numeric"
                min={1}
                value={state.getQuantity}
                onChange={(e) => patch({ getQuantity: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="promo-pct">
                Percentage off (100 = free)<span className="text-danger" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <Input
                  id="promo-pct"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  value={state.percentageOff}
                  onChange={(e) => patch({ percentageOff: e.target.value })}
                  className="pr-8"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  %
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {state.type === 'PERCENTAGE_DISCOUNT' ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-pct-only">
              Percentage off<span className="text-danger" aria-hidden="true">*</span>
            </label>
            <div className="relative max-w-[8rem]">
              <Input
                id="promo-pct-only"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                value={state.percentageOff}
                onChange={(e) => patch({ percentageOff: e.target.value })}
                className="pr-8"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
          </div>
        ) : null}

        {state.type === 'FIXED_AMOUNT_DISCOUNT' ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-amt">
              Amount off<span className="text-danger" aria-hidden="true">*</span>
            </label>
            <MoneyInput
              id="promo-amt"
              value={state.amountOff}
              onChange={(v) => patch({ amountOff: v })}
            />
          </div>
        ) : null}

        {/* Items */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Products</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setProductPickerOpen(true)}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              Add product
            </Button>
          </div>
          {state.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
              No products added yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {state.items.map((i) => (
                <li
                  key={i.productId}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{i.name ?? i.productId}</p>
                    <p className="text-[11px] text-muted-foreground">Role: {i.role}</p>
                  </div>
                  {state.type === 'BUY_X_GET_Y' ? (
                    <Select
                      value={i.role}
                      onChange={(e) =>
                        changeItemRole(i.productId, e.target.value as PromotionItem['role'])
                      }
                      className="w-24"
                      aria-label="Item role"
                    >
                      <option value="BUY">Buy</option>
                      <option value="GET">Get</option>
                    </Select>
                  ) : null}
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={i.quantity}
                    onChange={(e) => changeItemQuantity(i.productId, e.target.value)}
                    aria-label={`Quantity for ${i.name ?? i.productId}`}
                    className="w-20"
                  />
                  <button
                    type="button"
                    onClick={() => removeProduct(i.productId)}
                    className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                    aria-label={`Remove ${i.name ?? i.productId}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Schedule */}
      <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">Schedule</h2>
          <p className="text-xs text-muted-foreground">When and where the promotion applies.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-start">
              Start date
            </label>
            <Input
              id="promo-start"
              type="date"
              value={state.startsOn}
              onChange={(e) => patch({ startsOn: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-end">
              End date
            </label>
            <Input
              id="promo-end"
              type="date"
              value={state.endsOn}
              onChange={(e) => patch({ endsOn: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-start-time">
              Start time
            </label>
            <Input
              id="promo-start-time"
              type="time"
              value={state.startTime}
              onChange={(e) => patch({ startTime: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="promo-end-time">
              End time
            </label>
            <Input
              id="promo-end-time"
              type="time"
              value={state.endTime}
              onChange={(e) => patch({ endTime: e.target.value })}
            />
          </div>
        </div>

        <div>
          <span className="text-sm font-medium">Days of week</span>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Days of week">
            {PROMOTION_DAYS_OF_WEEK.map((d) => {
              const active = state.daysOfWeek.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggleDay(d)}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:border-primary hover:text-foreground'
                  }`}
                >
                  {DAY_LABELS[d]}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="text-sm font-medium">Channel</span>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Channels">
            {PROMOTION_CHANNELS.map((c) => {
              const active = state.channelScope.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggleChannel(c)}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:border-primary hover:text-foreground'
                  }`}
                >
                  {CHANNEL_LABELS[c]}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Empty means every channel.
          </p>
        </div>

        <div>
          <span className="text-sm font-medium">Branch scope</span>
          {branches.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Loading branches…</p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {branches.map((b) => {
                const checked = state.branchScope.includes(b.id);
                return (
                  <li key={b.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBranch(b.id)}
                        aria-label={`Include ${b.name}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <span className="text-[11px] text-muted-foreground">{b.code}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            Empty means every branch.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
          <Switch
            checked={state.stackable}
            onCheckedChange={(v) => patch({ stackable: v })}
            aria-label="Allow stacking with other promotions"
          />
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Stackable</span> — allow this promotion to
            combine with other applicable promotions on the same order.
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
        <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          leftIcon={
            saveState === 'saving' ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" />
            ) : saveState === 'saved' ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )
          }
        >
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : isEdit
                ? 'Save changes'
                : 'Create promotion'}
        </Button>
      </div>

      {productPickerOpen ? (
        <ProductSelectorDialog
          session={session}
          onSelect={addProduct}
          onBack={() => setProductPickerOpen(false)}
        />
      ) : null}

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Discard changes?"
        description="You have unsaved changes to this promotion."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => router.push(successHref)}>
              Discard &amp; leave
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Nothing has been saved yet.
        </p>
      </Dialog>

      {toast ? <Toast message={toast} tone="success" /> : null}
    </div>
  );
}

function MoneyInput({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative max-w-[12rem]">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
        LKR
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className="pl-12"
      />
    </div>
  );
}

