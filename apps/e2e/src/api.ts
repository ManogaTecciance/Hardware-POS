import { APIRequestContext, expect, request } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000/v1';

/** Unique-per-run suffix so tests never collide with seed data or each other. */
export const RUN_ID = `e2e${Date.now().toString(36)}`;
export const uniq = (label: string) => `${label} ${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;

export interface Auth {
  token: string;
  tenantId: string;
  refreshToken: string;
  user: { id: string; name: string; role: string };
  branch: { id: string; name: string } | null;
  register: { id: string; name: string } | null;
}

interface Envelope<T> {
  data: T;
}

export async function apiLogin(email: string, password: string, workspace?: string): Promise<Auth> {
  const ctx = await request.newContext();
  const res = await ctx.post(`${API_URL}/auth/login`, {
    // Omitted rather than sent empty: the API distinguishes "no workspace given"
    // from "a workspace that failed validation".
    data: workspace ? { email, password, workspace } : { email, password },
  });
  expect(res.ok(), `login as ${email}`).toBeTruthy();
  const { data } = (await res.json()) as Envelope<{
    token: string;
    refreshToken: string;
    user: { id: string; name: string; role: string; tenantId: string };
    branch: { id: string; name: string } | null;
    register: { id: string; name: string } | null;
  }>;
  await ctx.dispose();
  return {
    token: data.token,
    refreshToken: data.refreshToken,
    tenantId: data.user.tenantId,
    user: data.user,
    branch: data.branch,
    register: data.register,
  };
}

/** Thin authenticated API wrapper with `{data}` envelope unwrapping. */
export class Api {
  constructor(
    readonly ctx: APIRequestContext,
    readonly auth: Auth,
  ) {}

  static async create(auth: Auth): Promise<Api> {
    // NOTE: no baseURL. A leading-slash path resolves against the ORIGIN and
    // silently drops the "/v1" segment, so every path is joined to API_URL by
    // hand via `url()` instead.
    const ctx = await request.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${auth.token}`,
        'X-Tenant-Id': auth.tenantId,
      },
    });
    return new Api(ctx, auth);
  }

  private url(path: string): string {
    return `${API_URL}${path}`;
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await this.ctx.get(this.url(path));
    expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
    return ((await res.json()) as Envelope<T>).data;
  }

  async getRaw(path: string) {
    return this.ctx.get(this.url(path));
  }

  async post<T = any>(path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.post(this.url(path), { data });
    expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    const body = (await res.json().catch(() => ({ data: undefined }))) as Envelope<T>;
    return body.data;
  }

  async postRaw(path: string, data?: unknown) {
    return this.ctx.post(this.url(path), { data });
  }

  async patch<T = any>(path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.patch(this.url(path), { data });
    expect(res.ok(), `PATCH ${path} → ${res.status()}`).toBeTruthy();
    return ((await res.json()) as Envelope<T>).data;
  }

  async patchRaw(path: string, data?: unknown) {
    return this.ctx.patch(this.url(path), { data });
  }

  async deleteRaw(path: string) {
    return this.ctx.delete(this.url(path));
  }

  /** Upload a spreadsheet (import preview/commit take multipart `file`). */
  async uploadSheet(path: string, buffer: Buffer, filename = 'sheet.xlsx') {
    return this.ctx.post(this.url(path), {
      multipart: {
        file: {
          name: filename,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer,
        },
      },
    });
  }

  // ── Factories (all names carry RUN_ID so runs are self-contained) ─────────

  async createProduct(overrides: Record<string, unknown> = {}): Promise<any> {
    return this.post('/products', {
      name: uniq('E2E Product'),
      type: 'Inventory',
      unitPrice: 1000,
      quantityOnHand: 50,
      ...overrides,
    });
  }

  async createCustomer(overrides: Record<string, unknown> = {}): Promise<any> {
    return this.post('/customers', { name: uniq('E2E Customer'), ...overrides });
  }

  async createSupplier(overrides: Record<string, unknown> = {}): Promise<any> {
    return this.post('/suppliers', { name: uniq('E2E Vendor'), ...overrides });
  }

  /** Complete a simple cash sale for the given lines. */
  async completeSale(
    items: Array<{ productId: string; quantity: number }>,
    opts: { customerId?: string; payments?: Array<{ method: string; amount: number; reference?: string }> } = {},
  ): Promise<any> {
    // Server computes totals; a preview tells us what to tender for exact cash.
    const preview = await this.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: opts.customerId,
      items,
      payments: opts.payments ?? [{ method: 'CASH', amount: 10_000_000 }],
    });
    return preview;
  }

  /** Total for a cart via the quotation preview endpoint (same pricing engine). */
  async cartTotal(items: Array<{ productId: string; quantity: number }>): Promise<number> {
    const preview = await this.post('/quotations/preview', { items });
    return Number(preview.grandTotal);
  }
}

export const SEED = {
  owner: { email: 'owner@hardwarepos.test', password: 'password123' },
  cashier: { email: 'cashier@hardwarepos.test', password: 'password123' },
  /**
   * Approval PINs (discount / return prompts) — no longer a login credential
   * (D48). 2026-08-17: the hardware template staffs Owner + Cashier only, so
   * the OWNER holds the approver PIN; the old manager/accountant demo users
   * are gone. The manager-cap negative lives in the API integration spec
   * (discount-approval.spec.ts), whose fixtures own a MANAGER user.
   */
  approverPin: '2222',
  cashierPin: '1111',
  tenantId: 'tnt_dev',
  branchId: 'brn_dev',
  registerId: 'reg_dev',
  /** The Tile Shop workspace slug, for workspace-scoped sign-in. */
  workspace: 'demo',
};

/**
 * The Restaurant demo tenant (Slice 8.9 seed).
 *
 * A second tenant with a different business profile — RESTAURANT, LOCAL
 * inventory, no accounting provider — so the module-aware behaviour can be tested
 * against a real workspace rather than a mocked profile. It is also the
 * tenant-isolation subject: nothing it can see may belong to `tnt_dev`.
 */
export const RESTAURANT_SEED = {
  owner: { email: 'restaurant.owner@axlopos.test', password: 'Restaurant123!' },
  cashier: { email: 'restaurant.cashier@axlopos.test', password: 'Restaurant123!' },
  /** Approval PIN only (D48). */
  cashierPin: '3333',
  tenantId: 'tnt_resto',
  workspace: 'restaurant-demo',
  branchId: 'brn_resto',
  registerId: 'reg_resto',
};
