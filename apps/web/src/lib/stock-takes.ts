/**
 * Stock takes / cycle counts — D111 (`8.7`).
 *
 * The client sends only what was COUNTED. It never sends an expected quantity or
 * a variance: the server reads the book value inside the same transaction that
 * applies the count, so a stale number on a screen someone left open for an hour
 * cannot become the baseline a correction is computed from.
 */

import { api } from './api';
import type { Session } from './auth';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export interface StockTakeLineInput {
  productId: string;
  productVariantId?: string;
  countedQuantity: number;
}

export interface CreateStockTakeInput {
  branchId: string;
  lines: StockTakeLineInput[];
  note?: string;
  idempotencyKey?: string;
}

export interface StockTakeLineView {
  productId: string;
  productVariantId: string | null;
  productName: string;
  variantName: string | null;
  /** What the books said at the moment of the count. */
  expectedQuantity: string;
  countedQuantity: string;
  /** Negative is shrinkage, positive is a found item. */
  variance: string;
  /** `null` when nothing has ever been received — unknown, not zero (D110). */
  unitCost: string | null;
  varianceValue: string | null;
}

export interface StockTakeView {
  id: string;
  countNumber: string;
  branchId: string;
  countedAt: string;
  countedByUserId: string;
  countedByName: string | null;
  note: string | null;
  lines: StockTakeLineView[];
  varianceLines: number;
  varianceValue: string;
  /** Variance lines NOT included in `varianceValue`, because they have no cost. */
  unvaluedLines: number;
}

export function createStockTake(
  session: Session,
  input: CreateStockTakeInput,
): Promise<StockTakeView> {
  return api.post<StockTakeView>('/stock-takes', input, auth(session));
}

export function listStockTakes(session: Session): Promise<StockTakeView[]> {
  return api.get<StockTakeView[]>('/stock-takes', auth(session));
}

export function fetchStockTake(session: Session, id: string): Promise<StockTakeView> {
  return api.get<StockTakeView>(`/stock-takes/${id}`, auth(session));
}
