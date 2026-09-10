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

import { ProductSelectorDialog } from '@/components/products/product-selector-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
  PROMOTION_CHANNEL_LABELS,
  PROMOTION_DAY_LABELS,
  PROMOTION_DAYS_OF_WEEK,
  updatePromotion,
  type Promotion,
  type PromotionChannel,
  type PromotionDayOfWeek,
  type PromotionItem,
  type PromotionType,
} from '@/lib/products/promotions-api';
import { type ManagedProduct } from '@/lib/products-api';
import { describeTimeWindow } from '@/lib/products/promotion-schedule';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { getActiveCurrency } from '@/lib/tenant-money';
import { cn, formatMoney } from '@/lib/utils';

/**
 * Promotion editor (D45 — Promotions admin).
 *
 * Handles Create and Edit against a single component. Deliberate limits:
 *
 * - **Type is immutable after create.** The segmented control is disabled in
 *   edit mode; a Bundle cannot become a Percentage without redoing the item
 *   roles, and the backend enforces the same. Kept as a hard disable rather
 *   than a warning so the operator can't burn a save on a rejected PATCH.
 * - **Type shapes the fields.** Bundle asks for a fixed price; the two
 *   discount kinds share one item picker + a rate or amount. Fields that don't
 *   apply to the current type don't render — the server-side validator refuses
 *   stray fields too, but the UI never asks for them.
 * - **BUY_X_GET_Y is a sentence, not a field grid.** It renders its own two
 *   sections — "Customer buys" and "Customer gets" — instead of the shared
 *   product list, because its products answer two different questions. The
 *   section a product sits in IS its role, so there is no role dropdown to
 *   miss; the quantities sit beside the things they count; and the reward is
 *   Free or a percentage rather than a number where 100 secretly means free.
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
  /**
   * Where Cancel and a discarded edit return to. Defaults to the list. A
   * SUCCESSFUL save goes to the saved promotion's own page instead, so the
   * operator can check what they just configured.
   */
  successHref?: string;
}

interface EditorState {
  name: string;
  description: string;
  type: PromotionType;
  fixedPrice: string;
  percentageOff: string;
  amountOff: string;
  minimumSpend: string;
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
  /**
   * BUY_X_GET_Y only — whether the reward is free or discounted.
   *
   * Held explicitly rather than derived from `percentageOff === '100'`. Derived,
   * typing 100 into the percentage box would make the box vanish under the
   * operator's cursor. It never reaches the payload: Free simply writes 100.
   */
  rewardKind: 'FREE' | 'PERCENT';
  /**
   * FIXED_AMOUNT_DISCOUNT only — what the amount comes off.
   *
   * D126 makes this an emergent property of the item list: empty means the
   * whole cart. That is a real choice the operator is making, and expressing
   * it as the ABSENCE of rows meant they had to read a paragraph to discover
   * that an empty list was a setting — the same shape D140 took out of BOGO.
   * Held explicitly so the fields can follow it; the wire is unchanged, since
   * CART simply sends no items.
   */
  amountScope: 'CART' | 'PRODUCTS';
  items: Array<{ productId: string; role: PromotionItem['role']; quantity: string; name?: string }>;
}

/** Identity of an item row. Role is part of it: the same product can be the
 *  trigger AND the reward, which is how "buy 2, get 1 free" on one product is
 *  expressed (`@@unique([promotionId, productId, role])` allows the pair). */
function itemKey(item: { productId: string; role: PromotionItem['role'] }): string {
  return `${item.role}:${item.productId}`;
}

function emptyState(type: PromotionType = 'BUNDLE_FIXED_PRICE'): EditorState {
  return {
    name: '',
    description: '',
    type,
    fixedPrice: '',
    percentageOff: '',
    amountOff: '',
    minimumSpend: '',
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
    rewardKind: 'FREE',
    amountScope: 'CART',
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
    minimumSpend: p.minimumSpend != null ? String(p.minimumSpend) : '',
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
    // 100 IS free, so a saved reward at 100 reopens on the Free option rather
    // than as "percentage off: 100", which is the same offer said worse.
    rewardKind: p.percentageOff === 100 ? 'FREE' : 'PERCENT',
    // The stored shape says which it was: no items IS cart-level (D126).
    amountScope:
      p.type === 'FIXED_AMOUNT_DISCOUNT' && p.items.length === 0 ? 'CART' : 'PRODUCTS',
    items: p.items.map((i) => ({
      productId: i.productId,
      role: i.role,
      quantity: String(i.quantity ?? 1),
      // 4.10 — without this the edit screen rendered the raw cuid: `name` is
      // only set when a product comes from the picker, and the row falls back
      // to `productId`. Creating showed "Shirt"; editing the same promotion
      // showed "cmtldj0ta0003q4bs27ibki2q".
      name: i.productName ?? undefined,
    })),
  };
}

/**
 * The numeric rules, mirroring the DTOs rather than inventing limits.
 *
 * `type="number" min={0}` does NOT stop anyone typing `-10`: the attribute
 * marks the field `:invalid` and constrains the steppers, and with no native
 * form submit nothing was consulting it. So every one of these went to the
 * server and came back a 400 written for an API client — "FIXED_AMOUNT_DISCOUNT
 * requires a positive amountOff" — after a round trip, on a form the operator
 * had already left.
 *
 * The server still refuses all of it; this is about saying so first, in the
 * words of the field the operator is looking at. Limits come from
 * `dto/promotion.dto.ts` and `promotions.service.validateTypeShape`:
 * money is `@Min(0.01)` / `@Min(0)` at two decimal places, a percentage is
 * `(0, 100]`, and the BOGO quantities are `@IsInt @Min(1)`.
 */
type NumericRule = { label: string; value: string; min: number; max?: number; integer?: boolean };

function numericProblem({ label, value, min, max, integer }: NumericRule): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null; // "required" is a separate question, asked separately.
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (integer && !Number.isInteger(n)) return `${label} must be a whole number.`;
  if (n < min) {
    return min === 0
      ? `${label} cannot be negative.`
      : `${label} must be more than zero.`;
  }
  if (max !== undefined && n > max) return `${label} cannot be more than ${max}.`;
  /*
   * Money is `Decimal(12,2)` and the DTO refuses a third place outright, so a
   * silently-rounded figure never reaches the column. Asked as "is this a
   * whole number of cents", with a tolerance because 10.99 × 100 is
   * 1098.9999999999998 in binary floating point and would otherwise fail.
   */
  if (!integer && Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    return `${label} cannot have more than two decimal places.`;
  }
  return null;
}

/**
 * Every problem with the form, by field.
 *
 * A map rather than the first message, because a form with three bad fields
 * should not take three save attempts to discover them — and because a message
 * belongs under the field it is about, not in a banner at the foot of a form
 * long enough to have scrolled past it.
 *
 * Pure and taking the whole state, like the wizard's `validateStep`: the same
 * function answers "may this save?" and "what should each field say?", so the
 * two cannot disagree.
 */
export function validateAll(state: EditorState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!state.name.trim()) errors.name = 'Give the promotion a name.';

  /*
   * BUY_X_GET_Y names its two halves, because "add at least one product" is
   * useless advice on a form with two product slots — and because the server
   * refuses a missing GET with a message written for an API client.
   */
  if (state.type === 'BUY_X_GET_Y') {
    if (!state.items.some((i) => i.role === 'BUY')) {
      errors.itemsBuy = 'Choose the product the customer has to buy.';
    }
    if (!state.items.some((i) => i.role === 'GET')) {
      errors.itemsGet = 'Choose what the customer gets. Without it the promotion can never apply.';
    }
  } else if (state.type === 'FIXED_AMOUNT_DISCOUNT') {
    if (state.amountScope === 'PRODUCTS' && state.items.length === 0) {
      errors.items = 'Add the products the amount comes off, or switch to the whole cart.';
    }
  } else if (state.items.length === 0) {
    errors.items = 'Add at least one product.';
  }

  if (state.type === 'BUNDLE_FIXED_PRICE' && !state.fixedPrice) {
    errors.fixedPrice = 'Bundle promotions need a fixed price.';
  }
  if (state.type === 'PERCENTAGE_DISCOUNT' && !state.percentageOff) {
    errors.percentageOff = 'Set the percentage off.';
  }
  if (
    state.type === 'BUY_X_GET_Y' &&
    state.rewardKind === 'PERCENT' &&
    !state.percentageOff
  ) {
    // Free writes 100 itself, so this is only reachable with the percentage
    // option chosen and nothing typed.
    errors.percentageOff = 'Set how much comes off the reward, or choose Free.';
  }
  if (state.type === 'FIXED_AMOUNT_DISCOUNT' && !state.amountOff) {
    errors.amountOff = 'Set the amount off.';
  }

  /*
   * Ranges last, and only where the field is still empty-free: "you left it
   * blank" must never be reported as "it is out of range". Only the fields the
   * current type RENDERS are checked — the payload nulls the rest, so a stale
   * value behind a type switch is not the operator's problem.
   */
  const rules: (NumericRule & { key: string })[] = [];
  if (state.type === 'BUNDLE_FIXED_PRICE') {
    rules.push({ key: 'fixedPrice', label: 'Fixed price', value: state.fixedPrice, min: 0.01 });
  }
  if (state.type === 'PERCENTAGE_DISCOUNT') {
    rules.push({
      key: 'percentageOff',
      label: 'Percentage off',
      value: state.percentageOff,
      min: 0.01,
      max: 100,
    });
  }
  if (state.type === 'BUY_X_GET_Y') {
    rules.push(
      { key: 'buyQuantity', label: 'Buy quantity', value: state.buyQuantity, min: 1, integer: true },
      { key: 'getQuantity', label: 'Get quantity', value: state.getQuantity, min: 1, integer: true },
    );
    if (state.rewardKind === 'PERCENT') {
      rules.push({
        key: 'percentageOff',
        label: 'The discount on the reward',
        value: state.percentageOff,
        min: 0.01,
        max: 100,
      });
    }
  }
  if (state.type === 'FIXED_AMOUNT_DISCOUNT') {
    rules.push({ key: 'amountOff', label: 'Amount off', value: state.amountOff, min: 0.01 });
    if (state.amountScope === 'CART') {
      rules.push({ key: 'minimumSpend', label: 'Minimum spend', value: state.minimumSpend, min: 0 });
    }
  }
  for (const rule of rules) {
    if (errors[rule.key]) continue;
    const problem = numericProblem(rule);
    if (problem) errors[rule.key] = problem;
  }

  return errors;
}

/** One message, under the field it is about. */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-xs text-danger" role="alert">
      {message}
    </p>
  );
}

export function PromotionEditor({
  session,
  promotionId,
  initialPromotion,
  successHref = '/products/promotions',
}: Props) {
  const router = useRouter();
  /*
   * D56 (4.9) — the channels THIS tenant sells on, from the resolver.
   *
   * `capabilities.fulfilment.channels` already answers this per template —
   * `['COUNTER']` for retail, `['DINE_IN','TAKEAWAY','ONLINE']` for food service
   * — and this editor used to hardcode the food-service three. A retail
   * shopkeeper was offered Dine-in / Takeaway / Online, and picking any of them
   * scoped the promotion to a channel their till never sends, so
   * `isPromotionActive` refused it and the offer silently never fired.
   *
   * Unresolved is its own state (D31): while the profile loads, no chips render
   * rather than a guessed list. An empty scope already means "every channel", so
   * a promotion saved in that moment is unrestricted, never mis-restricted.
   */
  const { profile } = useEffectiveProfile();
  const channels = (profile?.capabilities.fulfilment.channels ?? []) as PromotionChannel[];
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
  /**
   * Which slot the product picker is filling, or null when it is closed.
   *
   * The role used to be an attribute the operator set on the row afterwards.
   * Carrying it on the OPEN instead is what lets "Customer buys" and "Customer
   * gets" be two sections rather than one list with a dropdown on every line.
   */
  const [pickerTarget, setPickerTarget] = React.useState<PromotionItem['role'] | null>(null);
  /** True once Create has been pressed — see the `errors` memo below. */
  const [attempted, setAttempted] = React.useState(false);
  const [submitTick, setSubmitTick] = React.useState(0);
  const formRef = React.useRef<HTMLDivElement>(null);
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

  const scheduleNotice = React.useMemo(
    () => describeTimeWindow(state.startTime, state.endTime),
    [state.startTime, state.endTime],
  );

  // ── BUY_X_GET_Y — the two halves of the sentence, and the sentence itself ──
  const buyItem = state.items.find((i) => i.role === 'BUY') ?? null;
  const getItems = state.items.filter((i) => i.role === 'GET');
  const rewardIsBuyItem =
    buyItem !== null && getItems.length === 1 && getItems[0]!.productId === buyItem.productId;

  /**
   * The offer in one line, regenerated as it is composed.
   *
   * A form can be filled in correctly and still not say what the operator
   * meant; reading the offer back is the cheapest check there is, and it is
   * what every mainstream promotion builder puts under this form. Null until
   * both halves exist — a half-written sentence is worse than none.
   */
  const bogoSummary = React.useMemo(() => {
    if (state.type !== 'BUY_X_GET_Y' || !buyItem || getItems.length === 0) return null;
    const buyQty = Number(state.buyQuantity) || 1;
    const getQty = Number(state.getQuantity) || 1;
    const rewardNames = getItems.map((i) => i.name ?? i.productId).join(' or ');
    const value =
      state.rewardKind === 'FREE'
        ? 'free'
        : `at ${state.percentageOff || '0'}% off`;
    return `Buy ${buyQty} × ${buyItem.name ?? buyItem.productId}, get ${getQty} × ${rewardNames} ${value}.`;
  }, [state.type, state.buyQuantity, state.getQuantity, state.rewardKind, state.percentageOff, buyItem, getItems]);

  /** The money-off offer in one line — same idea, same reason as above. */
  const amountSummary = React.useMemo(() => {
    if (state.type !== 'FIXED_AMOUNT_DISCOUNT') return null;
    const amount = Number(state.amountOff);
    if (!amount) return null;
    if (state.amountScope === 'CART') {
      const threshold = Number(state.minimumSpend);
      return threshold > 0
        ? `${formatMoney(amount)} off any basket of ${formatMoney(threshold)} or more.`
        : `${formatMoney(amount)} off the whole cart.`;
    }
    if (state.items.length === 0) return null;
    const names = state.items.map((i) => i.name ?? i.productId).join(', ');
    return `${formatMoney(amount)} off ${names}, spread across them.`;
  }, [state.type, state.amountScope, state.amountOff, state.minimumSpend, state.items]);

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
    const role: PromotionItem['role'] =
      pickerTarget ?? (state.type === 'BUNDLE_FIXED_PRICE' ? 'BUNDLE' : 'BUY');
    setState((prev) => {
      const row = { productId: product.id, role, quantity: '1', name: product.name };
      /*
       * The server allows exactly one BUY item on a BUY_X_GET_Y, so choosing
       * again in the Customer-buys section REPLACES rather than appends —
       * otherwise the operator composes something the save rejects with
       * "BUY_X_GET_Y requires exactly one BUY item", three fields later.
       */
      if (prev.type === 'BUY_X_GET_Y' && role === 'BUY') {
        return { ...prev, items: [...prev.items.filter((i) => i.role !== 'BUY'), row] };
      }
      // Deduped on (product, role), not product alone: the same product can be
      // both the trigger and the reward, which is how B2G1 on one item is said.
      if (prev.items.some((i) => itemKey(i) === itemKey(row))) return prev;
      return { ...prev, items: [...prev.items, row] };
    });
    setPickerTarget(null);
  };

  const removeItem = (key: string) => {
    setState((prev) => ({ ...prev, items: prev.items.filter((i) => itemKey(i) !== key) }));
  };

  const changeItemQuantity = (key: string, quantity: string) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((i) => (itemKey(i) === key ? { ...i, quantity } : i)),
    }));
  };

  /** The reward is the trigger — "buy 2 shirts, get a third free". */
  const toggleRewardSameAsBuy = (same: boolean) => {
    setState((prev) => {
      const buy = prev.items.find((i) => i.role === 'BUY');
      const withoutGets = prev.items.filter((i) => i.role !== 'GET');
      if (!same || !buy) return { ...prev, items: withoutGets };
      return {
        ...prev,
        items: [...withoutGets, { ...buy, role: 'GET' as const }],
      };
    });
  };

  /**
   * Switching scope takes the other mode's data with it.
   *
   * Not tidiness — correctness. A cart-level rule is defined by having NO
   * items, so leaving one behind would silently make the promotion
   * product-scoped again; and the engine never reads `minimumSpend` on a
   * product-scoped rule, so keeping a threshold there would persist a figure
   * that does nothing, which is the defect this whole section is fixing.
   */
  const setAmountScope = (scope: EditorState['amountScope']) =>
    setState((prev) => ({
      ...prev,
      amountScope: scope,
      minimumSpend: scope === 'CART' ? prev.minimumSpend : '',
      items: scope === 'CART' ? [] : prev.items,
    }));

  const setRewardKind = (kind: EditorState['rewardKind']) =>
    setState((prev) => ({
      ...prev,
      rewardKind: kind,
      // Only the box is cleared here; what Free MEANS is decided once, in the
      // payload, so a form left on its default cannot mean something else.
      percentageOff: kind === 'FREE' ? '' : prev.percentageOff,
    }));

  const errors = React.useMemo(
    // Once Create has been pressed, the messages FOLLOW the values. A snapshot
    // taken at submit time leaves a message standing under a field the
    // operator has already fixed, and the only way to find out whether it
    // worked is to press Create again — the same reason the product wizard
    // re-runs its validator on every change after the first attempt.
    () => (attempted ? validateAll(state) : {}),
    [attempted, state],
  );

  /**
   * Bring the first failed field into view when a save is blocked.
   *
   * Keyed on a tick rather than on the error map so pressing Create twice with
   * the same fault re-focuses instead of sitting there looking inert. A real
   * input is preferred because it can take focus; a section-level message
   * (`role="alert"`) is the fallback for the product lists, which have no one
   * input to blame. `scrollIntoView` is feature-checked: jsdom has none.
   */
  React.useEffect(() => {
    if (submitTick === 0) return;
    const root = formRef.current;
    if (!root) return;
    const field = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = field ?? root.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    field?.focus({ preventScroll: true });
  }, [submitTick]);

  const save = async () => {
    setAttempted(true);
    setSubmitTick((tick) => tick + 1);
    if (Object.keys(validateAll(state)).length > 0) {
      // The fields say what is wrong now; a banner repeating one of them would
      // be a second place to read the same thing, and the one further away.
      setError(null);
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
      /*
       * Free IS 100 on the wire, and this is the ONE place that is decided.
       * Writing '100' into the field when the radio changed looked equivalent
       * and was not: a form left on its default Free had never run that
       * handler, so it saved `percentageOff: null` and the server refused it.
       */
      percentageOff:
        state.type === 'BUY_X_GET_Y'
          ? state.rewardKind === 'FREE'
            ? 100
            : state.percentageOff
              ? Number(state.percentageOff)
              : null
          : state.type === 'PERCENTAGE_DISCOUNT'
            ? state.percentageOff
              ? Number(state.percentageOff)
              : null
            : null,
      amountOff:
        state.type === 'FIXED_AMOUNT_DISCOUNT' && state.amountOff ? Number(state.amountOff) : null,
      // D126 — only meaningful for money-off; the server rejects it elsewhere,
      // so send null rather than leaving a stale value from a type switch.
      /*
       * Only on a CART-level rule. The engine reads `minimumSpend` in exactly
       * one place — `resolveOrderPromotion`, which only ever sees rules with
       * no items — so a threshold saved beside a product list is a number that
       * can never be consulted. The form no longer offers the combination;
       * this makes sure an older draft cannot smuggle one through either.
       */
      minimumSpend:
        state.type === 'FIXED_AMOUNT_DISCOUNT' &&
        state.amountScope === 'CART' &&
        state.minimumSpend
          ? Number(state.minimumSpend)
          : null,
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
      let saved: Promotion;
      if (isEdit && promotionId) {
        saved = await updatePromotion(session, promotionId, commonPayload);
        setToast('Promotion updated.');
      } else {
        saved = await createPromotion(session, { ...commonPayload, type: state.type });
        setToast('Promotion created.');
      }
      setSaveState('saved');
      initialSnapshotRef.current = JSON.stringify(state);
      /*
       * Land on the saved promotion, not back on the list.
       *
       * The list shows a name, a type badge and a schedule summary — an
       * operator who had just configured a bundle's items, branch scope and
       * time window had nowhere to go to check any of it, and the only route
       * that showed those fields was the editor, which a PRODUCT_READ user is
       * refused. `successHref` stays what Cancel/discard honours.
       */
      setTimeout(() => router.push(`/products/promotions/${saved.id}`), 400);
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
    <div className="space-y-5" ref={formRef}>
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
            aria-invalid={!!errors.name}
            value={state.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Weekend Offer"
            maxLength={120}
            autoFocus
          />
          <FieldError message={errors.name} />
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
                {
                  value: 'FIXED_AMOUNT_DISCOUNT',
                  label: 'Amount off',
                  // D54 — the TENANT's currency, never the pilot's. This read
                  // is synchronous and cached, the same one every money
                  // formatter in the app uses.
                  icon: <span className="text-xs font-bold">{getActiveCurrency()}</span>,
                },
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
              invalid={!!errors.fixedPrice}
            />
            <FieldError message={errors.fixedPrice} />
            <p className="text-[11px] text-muted-foreground">
              Total price the operator charges for the whole bundle.
            </p>
          </div>
        ) : null}

        {/*
          * BUY_X_GET_Y reads as a sentence, in two labelled halves.
          *
          * The previous shape asked for Buy quantity, Get quantity and
          * "Percentage off (100 = free)" in one row of boxes, and then for
          * products in a separate list where each row carried a Role dropdown.
          * Three problems, all reported from the floor: the role of a product
          * was an attribute you had to notice and set (everything landed as
          * Buy, and a promotion with no Get item is silently skipped by the
          * pricing engine); the quantities sat far from the things they count;
          * and "100 = free" made the operator encode the commonest offer there
          * is as a magic number — one of them typed 7.
          *
          * Here the SECTION is the role, the quantity sits beside its own
          * product, and Free is an option rather than a number to know.
          */}
        {state.type === 'BUY_X_GET_Y' ? (
          <div className="space-y-3">
            {/* ── Customer buys ─────────────────────────────────────────── */}
            <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Customer buys</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerTarget('BUY')}
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  {buyItem ? 'Change product' : 'Choose product'}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="promo-buy-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={state.buyQuantity}
                  onChange={(e) => patch({ buyQuantity: e.target.value })}
                  aria-label="Buy quantity"
                  className="w-20"
                  aria-invalid={!!errors.buyQuantity}
                />
                <span aria-hidden="true" className="text-sm text-muted-foreground">
                  ×
                </span>
                {buyItem ? (
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {buyItem.name ?? buyItem.productId}
                  </span>
                ) : (
                  <span className="flex-1 text-sm text-muted-foreground">
                    No product chosen yet
                  </span>
                )}
              </div>
              <FieldError message={errors.buyQuantity} />
              <FieldError message={errors.itemsBuy} />
              <p className="text-[11px] text-muted-foreground">
                The trigger. Exactly one product — the server refuses this type with more
                than one, so choosing again replaces it.
              </p>
            </div>

            {/* ── Customer gets ─────────────────────────────────────────── */}
            <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Customer gets</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerTarget('GET')}
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  Add reward
                </Button>
              </div>

              {/* The commonest offer in retail — "buy 2, get a third free" —
                  needs the same product on both sides. One tap for it. */}
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rewardIsBuyItem}
                  disabled={!buyItem}
                  onChange={(e) => toggleRewardSameAsBuy(e.target.checked)}
                  aria-label="The reward is the same product the customer buys"
                />
                <span className={buyItem ? undefined : 'text-muted-foreground'}>
                  Same product as above
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="promo-get-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={state.getQuantity}
                  onChange={(e) => patch({ getQuantity: e.target.value })}
                  aria-label="Get quantity"
                  className="w-20"
                  aria-invalid={!!errors.getQuantity}
                />
                <span aria-hidden="true" className="text-sm text-muted-foreground">
                  ×
                </span>
                {getItems.length === 0 ? (
                  <span className="flex-1 text-sm text-muted-foreground">
                    No reward chosen yet
                  </span>
                ) : (
                  <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {getItems.map((i) => (
                      <li
                        key={itemKey(i)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-sm"
                      >
                        <span className="truncate">{i.name ?? i.productId}</span>
                        <button
                          type="button"
                          onClick={() => removeItem(itemKey(i))}
                          className="text-muted-foreground hover:text-danger"
                          aria-label={`Remove ${i.name ?? i.productId}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <FieldError message={errors.getQuantity} />
              <FieldError message={errors.itemsGet} />

              <fieldset className="space-y-1.5">
                <legend className="text-xs font-medium text-muted-foreground">
                  What the reward costs
                </legend>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="promo-reward-kind"
                      checked={state.rewardKind === 'FREE'}
                      onChange={() => setRewardKind('FREE')}
                    />
                    Free
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="promo-reward-kind"
                      checked={state.rewardKind === 'PERCENT'}
                      onChange={() => setRewardKind('PERCENT')}
                    />
                    Percentage off
                  </label>
                  {state.rewardKind === 'PERCENT' ? (
                    <div className="relative w-28">
                      <Input
                        id="promo-pct"
                        type="number"
                        inputMode="decimal"
                        min={1}
                        max={100}
                        value={state.percentageOff}
                        onChange={(e) => patch({ percentageOff: e.target.value })}
                        aria-label="Percentage off the reward"
                        className="pr-8"
                        aria-invalid={!!errors.percentageOff}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        %
                      </span>
                    </div>
                  ) : null}
                </div>
                <FieldError message={errors.percentageOff} />
              </fieldset>
            </div>

            {/* The offer, read back. `role="status"` so a screen reader hears
                it change rather than having to go looking for it. */}
            {bogoSummary ? (
              <p
                role="status"
                className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-700"
              >
                {bogoSummary}
              </p>
            ) : null}
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
                aria-invalid={!!errors.percentageOff}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
            <FieldError message={errors.percentageOff} />
          </div>
        ) : null}

        {/*
          * FIXED_AMOUNT_DISCOUNT states its scope instead of implying it.
          *
          * D126 defines a cart-level money-off as one with NO products, and
          * this form used to express that as an empty list plus a paragraph
          * explaining that the empty list was a setting. Two costs, both real:
          * the operator had to read prose to find the choice, and the form
          * happily accepted a Minimum spend ALONGSIDE products — a combination
          * the engine cannot honour, because `minimumSpend` is read only in
          * `resolveOrderPromotion`, which never sees a rule that names
          * products. The threshold was accepted, stored, and ignored.
          *
          * Making the scope a choice lets the fields follow it, so the
          * unhonourable combination is unreachable rather than undocumented.
          */}
        {state.type === 'FIXED_AMOUNT_DISCOUNT' ? (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What it discounts</legend>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="promo-amount-scope"
                    checked={state.amountScope === 'CART'}
                    onChange={() => setAmountScope('CART')}
                  />
                  The whole cart
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="promo-amount-scope"
                    checked={state.amountScope === 'PRODUCTS'}
                    onChange={() => setAmountScope('PRODUCTS')}
                  />
                  Specific products
                </label>
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="promo-amt">
                Amount off<span className="text-danger" aria-hidden="true">*</span>
              </label>
              <MoneyInput
                id="promo-amt"
                value={state.amountOff}
                onChange={(v) => patch({ amountOff: v })}
                invalid={!!errors.amountOff}
              />
              <FieldError message={errors.amountOff} />
              {state.amountScope === 'PRODUCTS' ? (
                <p className="text-[11px] text-muted-foreground">
                  Spread across the products below, in proportion to what each costs.
                </p>
              ) : null}
            </div>

            {/* Only where it can actually be honoured. */}
            {state.amountScope === 'CART' ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="promo-min-spend">
                  Minimum spend
                </label>
                <MoneyInput
                  id="promo-min-spend"
                  value={state.minimumSpend}
                  onChange={(v) => patch({ minimumSpend: v })}
                  invalid={!!errors.minimumSpend}
                />
                <FieldError message={errors.minimumSpend} />
                <p className="text-[11px] text-muted-foreground">
                  Blank means no threshold. A basket that reaches this figure exactly
                  qualifies.
                </p>
              </div>
            ) : null}

            {amountSummary ? (
              <p
                role="status"
                className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-700"
              >
                {amountSummary}
              </p>
            ) : null}
          </div>
        ) : null}

        {/*
          * The flat product list, for the types that have ONE list.
          *
          * BUY_X_GET_Y renders its own two sections above — its products are
          * not a list with a role attribute, they are two different questions.
          * A cart-level money-off has no products by definition, so offering
          * the list there is offering the operator a way to contradict the
          * scope they just chose.
          */}
        {state.type !== 'BUY_X_GET_Y' &&
        !(state.type === 'FIXED_AMOUNT_DISCOUNT' && state.amountScope === 'CART') ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Products</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setPickerTarget(state.type === 'BUNDLE_FIXED_PRICE' ? 'BUNDLE' : 'BUY')
                }
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
                    key={itemKey(i)}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{i.name ?? i.productId}</p>
                    </div>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={i.quantity}
                      onChange={(e) => changeItemQuantity(itemKey(i), e.target.value)}
                      aria-label={`Quantity for ${i.name ?? i.productId}`}
                      className="w-20"
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(itemKey(i))}
                      className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                      aria-label={`Remove ${i.name ?? i.productId}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FieldError message={errors.items} />
          </div>
        ) : null}
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

        {/*
          * A window that can never contain a moment, or one so short it is
          * almost certainly a mis-click. Said here, beside the fields, rather
          * than as a save error — and the short-window case is a warning, not a
          * block, because a flash sale is a real thing to want.
          */}
        {scheduleNotice ? (
          <p
            role={scheduleNotice.level === 'error' ? 'alert' : 'status'}
            className={cn(
              'rounded-lg border p-2.5 text-xs',
              scheduleNotice.level === 'error'
                ? 'border-danger/40 bg-danger-soft text-danger'
                : 'border-warning/40 bg-warning-soft text-warning',
            )}
          >
            {scheduleNotice.message}
          </p>
        ) : null}

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
                  {PROMOTION_DAY_LABELS[d]}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="text-sm font-medium">Channel</span>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Channels">
            {channels.map((c) => {
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
                  {PROMOTION_CHANNEL_LABELS[c]}
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
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Stackable</span> — allow this promotion
              to combine with other applicable promotions on the same order.
            </p>
            {/*
              * The old text stopped at the line above, and an operator read it as
              * "these two offers will both apply". They will not if they share a
              * product: one line carries one promotion, because `SaleItem` holds a
              * single `promotionId`. The engine gives the basket to whichever saves
              * more, so the toggle changes nothing for an overlapping pair — which
              * looks exactly like a broken switch. Say so here rather than let the
              * next person work it out from a cart that will not budge.
              */}
            <p>
              Only affects promotions covering <span className="font-medium">different</span>{' '}
              products. A single item can never carry two promotions — where two overlap, the one
              that discounts more applies and the other is skipped.
            </p>
          </div>
        </div>
      </section>

      {/* The SERVER's word only — a 409 for a duplicate name, a refused
          channel — which is the part no client-side rule can know. Everything
          the form can judge for itself is said at its field. */}
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

      {pickerTarget !== null ? (
        <ProductSelectorDialog
          session={session}
          onSelect={addProduct}
          onBack={() => setPickerTarget(null)}
          title={
            pickerTarget === 'GET'
              ? 'Choose the reward'
              : pickerTarget === 'BUY' && state.type === 'BUY_X_GET_Y'
                ? 'Choose the product the customer buys'
                : 'Add a product to this promotion'
          }
          description={
            state.type === 'BUY_X_GET_Y'
              ? 'The section you opened this from decides its part in the offer.'
              : 'Pick the product this promotion applies to. Its quantity is set on the row once it is added.'
          }
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
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="relative max-w-[12rem]">
      {/* D54 — a tenant billing in USD must not be asked for an amount in
          LKR. `pl-12` still fits: every ISO 4217 code is three characters. */}
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
        {getActiveCurrency()}
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
        aria-invalid={invalid}
      />
    </div>
  );
}

