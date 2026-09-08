/**
 * Held baskets — `8.8`.
 *
 * A hold is a DRAFT sale. These three calls are the flow that `SaleStatus.DRAFT`
 * has been waiting for since Phase 1: put one down, find it again, throw it
 * away. Resuming needs no call of its own — the checkout's existing completion
 * path takes a `saleId`, and always could.
 */

import { api } from './api';
import type { Session } from './auth';
import type { CartItem } from './cart';
import { toSaleItemPayload, type SaleItemPayload } from './sales';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

/**
 * A held line is a sale line plus its note. The same mapper as the sale
 * builds it: a basket that comes back from the fitting room must ring up
 * exactly as it was held, and a second field list here is where a per-unit
 * discount would quietly turn into a whole-line one (D136).
 */
export type DraftLinePayload = SaleItemPayload & { note?: string };

export function toDraftLinePayload(item: CartItem): DraftLinePayload {
  return { ...toSaleItemPayload(item), note: item.note };
}

export interface CreateDraftPayload {
  branchId: string;
  registerId?: string;
  customerId?: string;
  items: DraftLinePayload[];
}

export interface HeldSaleLine {
  productId: string | null;
  productVariantId: string | null;
  productName: string;
  /** "Medium / Black" as it was when the basket was put down (D44). */
  variantNameSnapshot: string | null;
  quantity: number;
}

export interface HeldSale {
  id: string;
  saleNumber: string;
  createdAt: string;
  branchId: string;
  customerId: string | null;
  customerName: string | null;
  cashierName: string | null;
  subtotal: number;
  items: HeldSaleLine[];
}

/** The API shape, before the numeric fields are narrowed. */
interface ApiHeldSale {
  id: string;
  saleNumber: string;
  createdAt: string;
  branchId: string;
  customerId: string | null;
  customer?: { name: string } | null;
  cashier?: { name: string } | null;
  subtotal: string | number;
  items: {
    productId: string | null;
    productVariantId: string | null;
    productName: string;
    variantNameSnapshot: string | null;
    quantity: string | number;
  }[];
}

function toHeldSale(row: ApiHeldSale): HeldSale {
  return {
    id: row.id,
    saleNumber: row.saleNumber,
    createdAt: row.createdAt,
    branchId: row.branchId,
    customerId: row.customerId,
    customerName: row.customer?.name ?? null,
    cashierName: row.cashier?.name ?? null,
    subtotal: Number(row.subtotal),
    items: row.items.map((i) => ({
      productId: i.productId,
      productVariantId: i.productVariantId,
      productName: i.productName,
      variantNameSnapshot: i.variantNameSnapshot,
      quantity: Number(i.quantity),
    })),
  };
}

export async function createDraftSale(
  session: Session,
  payload: CreateDraftPayload,
): Promise<HeldSale> {
  const row = await api.post<ApiHeldSale>('/sales/draft', payload, auth(session));
  return toHeldSale(row);
}

export async function listHeldSales(session: Session, branchId?: string): Promise<HeldSale[]> {
  const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  const rows = await api.get<ApiHeldSale[]>(`/sales/held${q}`, auth(session));
  return rows.map(toHeldSale);
}

export function discardHeldSale(session: Session, id: string): Promise<void> {
  return api.del<void>(`/sales/held/${id}`, auth(session));
}
