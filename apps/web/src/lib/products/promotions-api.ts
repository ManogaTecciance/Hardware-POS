/**
 * Promotions client (D45 — Phase 2 Promotions module).
 *
 * The backend exposes `/promotions` under the `INVENTORY` module. `type` is
 * immutable after creation (a Bundle cannot become a Percentage discount mid-
 * flight without re-doing the item roles), so the PATCH input intentionally
 * omits it.
 *
 * Decimals arrive as strings from Prisma; every hop here normalises them to
 * `number`, matching the convention set in `variants-api.ts`. Timestamps stay
 * strings — presentational formatting is the caller's job.
 */

import { api } from '../api';
import type { Session } from '../auth';

// ── Enums ────────────────────────────────────────────────────────────────────

export type PromotionType =
  | 'BUNDLE_FIXED_PRICE'
  | 'BUY_X_GET_Y'
  | 'PERCENTAGE_DISCOUNT'
  | 'FIXED_AMOUNT_DISCOUNT';

export type PromotionItemRole = 'BUY' | 'GET' | 'BUNDLE';

export type PromotionDayOfWeek = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

/**
 * D56 (4.9) — every channel `OrderChannel` has, not the food-service three.
 *
 * `COUNTER` is the channel a RETAIL till sells on — `catalog.ts` and
 * `sales.service` both send it — and it was missing here. A retail shopkeeper
 * ticking "Dine-in" scoped their promotion to a channel their tenant never uses,
 * so `isPromotionActive` refused it and the offer silently never fired.
 */
export type PromotionChannel = 'COUNTER' | 'DINE_IN' | 'TAKEAWAY' | 'ONLINE';

export const PROMOTION_DAYS_OF_WEEK: PromotionDayOfWeek[] = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
];

/**
 * Every channel the enum has. NOT what an editor should offer — a template shows
 * only the channels its own `capabilities.fulfilment.channels` declares (D56).
 * Kept for typing and for tests that need the full set.
 */
export const PROMOTION_CHANNELS: PromotionChannel[] = [
  'COUNTER',
  'DINE_IN',
  'TAKEAWAY',
  'ONLINE',
];

// ── Views ────────────────────────────────────────────────────────────────────

export interface PromotionItem {
  id: string;
  productId: string;
  role: PromotionItemRole;
  quantity: number;
}

export interface Promotion {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  type: PromotionType;
  fixedPrice: number | null;
  percentageOff: number | null;
  amountOff: number | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  startsOn: string | null;
  endsOn: string | null;
  daysOfWeek: PromotionDayOfWeek[];
  startTime: string | null;
  endTime: string | null;
  branchScope: string[];
  channelScope: PromotionChannel[];
  stackable: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  items: PromotionItem[];
}

// ── Raw wire shapes ──────────────────────────────────────────────────────────

interface ApiPromotionItem {
  id: string;
  productId: string;
  role: PromotionItemRole;
  quantity: string | number;
}

interface ApiPromotion {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  type: PromotionType;
  fixedPrice: string | number | null;
  percentageOff: string | number | null;
  amountOff: string | number | null;
  buyQuantity: string | number | null;
  getQuantity: string | number | null;
  startsOn: string | null;
  endsOn: string | null;
  daysOfWeek: PromotionDayOfWeek[];
  startTime: string | null;
  endTime: string | null;
  branchScope: string[];
  channelScope: PromotionChannel[];
  stackable: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  items: ApiPromotionItem[];
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function toItem(i: ApiPromotionItem): PromotionItem {
  return {
    id: i.id,
    productId: i.productId,
    role: i.role,
    quantity: Number(i.quantity),
  };
}

function toPromotion(p: ApiPromotion): Promotion {
  return {
    id: p.id,
    tenantId: p.tenantId,
    name: p.name,
    description: p.description,
    type: p.type,
    fixedPrice: p.fixedPrice != null ? Number(p.fixedPrice) : null,
    percentageOff: p.percentageOff != null ? Number(p.percentageOff) : null,
    amountOff: p.amountOff != null ? Number(p.amountOff) : null,
    buyQuantity: p.buyQuantity != null ? Number(p.buyQuantity) : null,
    getQuantity: p.getQuantity != null ? Number(p.getQuantity) : null,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    daysOfWeek: p.daysOfWeek ?? [],
    startTime: p.startTime,
    endTime: p.endTime,
    branchScope: p.branchScope ?? [],
    channelScope: p.channelScope ?? [],
    stackable: p.stackable,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    items: (p.items ?? []).map(toItem),
  };
}

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface PromotionItemInput {
  productId: string;
  role: PromotionItemRole;
  quantity?: number;
}

export interface PromotionCreateInput {
  name: string;
  description?: string | null;
  type: PromotionType;
  fixedPrice?: number | null;
  percentageOff?: number | null;
  amountOff?: number | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  startsOn?: string | null;
  endsOn?: string | null;
  daysOfWeek?: PromotionDayOfWeek[];
  startTime?: string | null;
  endTime?: string | null;
  branchScope?: string[];
  channelScope?: PromotionChannel[];
  stackable?: boolean;
  items: PromotionItemInput[];
}

/**
 * PATCH body — identical to create minus the immutable `type` (see above).
 * `items` still replaces the whole item set wholesale on the server side.
 */
export type PromotionPatchInput = Omit<PromotionCreateInput, 'type'>;

// ── List query ────────────────────────────────────────────────────────────────

export interface PromotionsQuery {
  branchId?: string;
  channel?: PromotionChannel;
  productId?: string;
  isActive?: boolean;
  onlyCurrentlyValid?: boolean;
  limit?: number;
  offset?: number;
}

function queryString(q: PromotionsQuery): string {
  const params = new URLSearchParams();
  if (q.branchId) params.set('branchId', q.branchId);
  if (q.channel) params.set('channel', q.channel);
  if (q.productId) params.set('productId', q.productId);
  if (q.isActive !== undefined) params.set('isActive', String(q.isActive));
  if (q.onlyCurrentlyValid !== undefined) {
    params.set('onlyCurrentlyValid', String(q.onlyCurrentlyValid));
  }
  if (q.limit != null) params.set('limit', String(q.limit));
  if (q.offset != null) params.set('offset', String(q.offset));
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export async function fetchPromotions(
  session: Session,
  query: PromotionsQuery = {},
): Promise<{ items: Promotion[]; total: number }> {
  const res = await api.get<{ items: ApiPromotion[]; total: number }>(
    `/promotions${queryString(query)}`,
    auth(session),
  );
  return { items: res.items.map(toPromotion), total: res.total };
}

export async function fetchPromotion(session: Session, id: string): Promise<Promotion> {
  const res = await api.get<ApiPromotion>(`/promotions/${id}`, auth(session));
  return toPromotion(res);
}

export async function createPromotion(
  session: Session,
  input: PromotionCreateInput,
): Promise<Promotion> {
  const res = await api.post<ApiPromotion>('/promotions', input, auth(session));
  return toPromotion(res);
}

export async function updatePromotion(
  session: Session,
  id: string,
  patch: PromotionPatchInput,
): Promise<Promotion> {
  const res = await api.patch<ApiPromotion>(`/promotions/${id}`, patch, auth(session));
  return toPromotion(res);
}

export async function deletePromotion(
  session: Session,
  id: string,
): Promise<{ id: string }> {
  return api.del<{ id: string }>(`/promotions/${id}`, auth(session));
}

export async function activatePromotion(session: Session, id: string): Promise<Promotion> {
  const res = await api.post<ApiPromotion>(`/promotions/${id}/activate`, undefined, auth(session));
  return toPromotion(res);
}

export async function deactivatePromotion(session: Session, id: string): Promise<Promotion> {
  const res = await api.post<ApiPromotion>(
    `/promotions/${id}/deactivate`,
    undefined,
    auth(session),
  );
  return toPromotion(res);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simple role heuristic used when linking an existing promotion to a new
 * product from the wizard: Bundles carry BUNDLE items, BOGO carries a BUY
 * (the "must buy" trigger), and discount types treat the product as the
 * discounted BUY item.
 *
 * Never GET — GET is only meaningful for the reward item on a BOGO, which the
 * wizard's link flow does not attempt to configure.
 */
export function defaultRoleForPromotionType(type: PromotionType): PromotionItemRole {
  if (type === 'BUNDLE_FIXED_PRICE') return 'BUNDLE';
  if (type === 'BUY_X_GET_Y') return 'BUY';
  return 'BUY';
}

/**
 * Short human-readable label for a promotion type. Kept centralised so the
 * list, editor and wizard picker cannot drift on the wording.
 */
export function labelForPromotionType(type: PromotionType): string {
  switch (type) {
    case 'BUNDLE_FIXED_PRICE':
      return 'Bundle';
    case 'BUY_X_GET_Y':
      return 'Buy X, Get Y';
    case 'PERCENTAGE_DISCOUNT':
      return 'Percentage off';
    case 'FIXED_AMOUNT_DISCOUNT':
      return 'Amount off';
  }
}

const DAY_LABEL: Record<PromotionDayOfWeek, string> = {
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
};

/**
 * One-line schedule summary for the promotions list row — "Fridays 5–10 PM",
 * "Mon–Fri", "All week", etc. Prefers day + time-window if both are present
 * and otherwise falls back to the coarser signal.
 */
export function summarisePromotionSchedule(p: Pick<Promotion, 'daysOfWeek' | 'startTime' | 'endTime' | 'startsOn' | 'endsOn'>): string {
  const parts: string[] = [];
  if (p.daysOfWeek.length === 0 || p.daysOfWeek.length === 7) {
    parts.push('All week');
  } else {
    parts.push(p.daysOfWeek.map((d) => DAY_LABEL[d]).join(', '));
  }
  if (p.startTime && p.endTime) {
    parts.push(`${p.startTime}–${p.endTime}`);
  } else if (p.startTime) {
    parts.push(`from ${p.startTime}`);
  } else if (p.endTime) {
    parts.push(`until ${p.endTime}`);
  }
  if (p.startsOn && p.endsOn) {
    parts.push(`(${p.startsOn.slice(0, 10)} → ${p.endsOn.slice(0, 10)})`);
  } else if (p.startsOn) {
    parts.push(`(from ${p.startsOn.slice(0, 10)})`);
  } else if (p.endsOn) {
    parts.push(`(until ${p.endsOn.slice(0, 10)})`);
  }
  return parts.join(' · ');
}
