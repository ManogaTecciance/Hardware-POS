/**
 * Route → module classification, and proof that it is complete (Slice 7.6).
 *
 * ## What makes this non-vacuous
 *
 * A "every route is classified" test is trivially satisfiable by iterating an
 * empty list, so three things hold it up:
 *
 *  1. The route list is read from **Nest's own metadata** on the real controller
 *    classes, not from a source grep. It is what the framework will serve.
 *  2. `collectRoutes` throws when handed no controllers, and when a controller
 *    exposes no routes — so a broken probe fails loudly rather than silently
 *    classifying nothing.
 *  3. The controller registry is compared against every `*.controller.ts` file on
 *    disk, so a new controller that is never registered fails by name.
 *
 * The classification below is an **exact map**, not a count: every route names its
 * module and whether the module guard is actually enforced on it. A route added,
 * removed, renamed, or re-gated fails this file until the decision is recorded.
 *
 * ## `guard` values
 *
 *  • `ENFORCED` — `@RequireModule` is on the route (or its controller) today.
 *  • `shared-core` — authentication, tenant isolation and permissions only. These
 *    routes must work for **every** business profile, so gating them would be
 *    wrong, not merely unfinished.
 *  • `deferred-retail-pos` — classified `RETAIL_POS`, not yet gated. Gating the
 *    sale/payment/receipt path would deny a Restaurant tenant read access to its
 *    own sales history, which the Slice 8 Restaurant navigation shows. Splitting
 *    read from write needs the Phase 2 ordering model to be settled first.
 *  • `deferred-mixed-controller` — `DocumentsController` serves sale bills, return
 *    notes and settings previews from one class. Route-level gating is the right
 *    answer and is deferred with the rest of the document work.
 *  • `public-no-tenant` — `@Public()` routes. `ModuleAccessGuard` denies any route
 *    that requires a module without an authenticated tenant (the `x-tenant-id`
 *    header is client-supplied and must not be trusted), so these **cannot** carry
 *    a module guard. The QuickBooks OAuth callback and the public quotation link
 *    are both in this class; each enforces its own token instead.
 *
 * Keep `docs/restaurant-pos/route-module-matrix.md` in step with this table — a
 * test below asserts the document lists the same totals.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ALL_CONTROLLERS,
  REGISTERED_CONTROLLER_FILES,
} from '../testkit/controller-registry';
import { collectRoutes, discoverControllerFiles } from '../testkit/route-inventory';

const API_SRC = resolve(__dirname, '../..');
const MATRIX_DOC = resolve(
  __dirname,
  '../../../../../docs/restaurant-pos/route-module-matrix.md',
);

type GuardState =
  | 'ENFORCED'
  | 'shared-core'
  | 'deferred-retail-pos'
  | 'deferred-mixed-controller'
  | 'public-no-tenant';

interface Classification {
  module: string;
  guard: GuardState;
}

/** Every route the API serves, classified. Exactly 139 entries at Slice 7. */
const ROUTE_CLASSIFICATION: Record<string, Classification> = {
  'GET /audit-logs': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /auth/login': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /auth/logout': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /auth/me': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /auth/pin-login': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /auth/refresh': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /branches': { module: 'BRANCHES', guard: 'ENFORCED' },
  'GET /categories': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /customers': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'POST /customers': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'GET /customers/:id': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'PATCH /customers/:id': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'POST /customers/:id/sync-to-quickbooks': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /customers/import/commit': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'POST /customers/import/preview': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'GET /customers/import/template': { module: 'CUSTOMERS', guard: 'ENFORCED' },
  'GET /dashboard/payment-methods': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/sales-series': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/shift-summary': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/stats': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/summary': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/top-categories': { module: 'REPORTING', guard: 'ENFORCED' },
  'GET /dashboard/top-products': { module: 'REPORTING', guard: 'ENFORCED' },
  'POST /discounts/approve': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /documents/preview/:type': { module: 'SETTINGS', guard: 'deferred-mixed-controller' },
  'GET /documents/returns/:returnId': { module: 'RETURNS', guard: 'deferred-mixed-controller' },
  'GET /documents/sales/:saleId': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /documents/sample-pdf/:type': { module: 'SETTINGS', guard: 'deferred-mixed-controller' },
  'GET /health': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /payments': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /payments': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /payments/:id': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /platform/modules': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /platform/profile': { module: 'SHARED_CORE', guard: 'shared-core' },
  'PATCH /platform/profile': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /print-jobs': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /print-jobs/:id/mark-printed': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /product-categories': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-categories': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /product-categories/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'PATCH /product-categories/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-categories/:id/deactivate': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-categories/:id/reactivate': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-categories/reorder': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /product-subcategories': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-subcategories': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /product-subcategories/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'PATCH /product-subcategories/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-subcategories/:id/deactivate': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-subcategories/:id/move': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-subcategories/:id/reactivate': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /product-subcategories/reorder': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /products': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /products': { module: 'SHARED_CORE', guard: 'shared-core' },
  'DELETE /products/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /products/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'PATCH /products/:id': { module: 'SHARED_CORE', guard: 'shared-core' },
  'DELETE /products/:id/image': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /products/:id/image': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /products/:id/sync-to-quickbooks': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /products/import/commit': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /products/import/preview': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /products/import/template': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /products/report': { module: 'SHARED_CORE', guard: 'shared-core' },
  'GET /products/search': { module: 'SHARED_CORE', guard: 'shared-core' },
  'POST /products/sync/mock': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /public/quotations/:token': { module: 'QUOTATIONS', guard: 'public-no-tenant' },
  'GET /quickbooks/callback': { module: 'QUICKBOOKS', guard: 'public-no-tenant' },
  'GET /quickbooks/connect': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /quickbooks/disconnect': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /quickbooks/party-sync-status': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /quickbooks/retry/:syncLogId': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /quickbooks/status': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /quickbooks/sync': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /quickbooks/sync-products': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /quickbooks/sync-sale/:saleId': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /quickbooks/vendors': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /quotations': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'GET /quotations/:id': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'PATCH /quotations/:id': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/cancel': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/convert-to-sale': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/duplicate': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/mark-sent': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'GET /quotations/:id/pdf': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'GET /quotations/:id/revisions': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/revisions': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'GET /quotations/:id/revisions/:revisionId': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/share/email': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/:id/share/whatsapp': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'POST /quotations/preview': { module: 'QUOTATIONS', guard: 'ENFORCED' },
  'GET /receipts/:id': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /receipts/:saleId/customer': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /receipts/sale/:saleId': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /returns': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns': { module: 'RETURNS', guard: 'ENFORCED' },
  'GET /returns/:id': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns/:id/cancel': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns/:id/receipt': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns/:id/retry-sync': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns/approve': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /returns/preview': { module: 'RETURNS', guard: 'ENFORCED' },
  'GET /sales': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /sales/:id': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /sales/:id/retry-sync': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /sales/:id/return-eligibility': { module: 'RETURNS', guard: 'ENFORCED' },
  'GET /sales/:id/returnable-items': { module: 'RETURNS', guard: 'ENFORCED' },
  'GET /sales/:id/returns': { module: 'RETURNS', guard: 'ENFORCED' },
  'POST /sales/:id/sync': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /sales/complete': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'POST /sales/draft': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /sales/report': { module: 'RETAIL_POS', guard: 'deferred-retail-pos' },
  'GET /settings': { module: 'SETTINGS', guard: 'ENFORCED' },
  'PUT /settings': { module: 'SETTINGS', guard: 'ENFORCED' },
  'DELETE /settings/document-profile/logo': { module: 'SETTINGS', guard: 'ENFORCED' },
  'POST /settings/document-profile/logo': { module: 'SETTINGS', guard: 'ENFORCED' },
  'DELETE /settings/document-profile/signature': { module: 'SETTINGS', guard: 'ENFORCED' },
  'POST /settings/document-profile/signature': { module: 'SETTINGS', guard: 'ENFORCED' },
  'DELETE /settings/document-profile/stamp': { module: 'SETTINGS', guard: 'ENFORCED' },
  'POST /settings/document-profile/stamp': { module: 'SETTINGS', guard: 'ENFORCED' },
  'POST /settings/reset': { module: 'SETTINGS', guard: 'ENFORCED' },
  'GET /suppliers': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'POST /suppliers': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'DELETE /suppliers/:id': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'GET /suppliers/:id': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'PATCH /suppliers/:id': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'DELETE /suppliers/:id/quickbooks-mapping': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'POST /suppliers/:id/quickbooks-mapping': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'POST /suppliers/import/commit': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'POST /suppliers/import/preview': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'GET /suppliers/import/template': { module: 'SUPPLIERS', guard: 'ENFORCED' },
  'GET /sync/logs': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /sync/products/refresh': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'POST /sync/sales/:id/retry': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /sync/status': { module: 'QUICKBOOKS', guard: 'ENFORCED' },
  'GET /users': { module: 'USERS', guard: 'ENFORCED' },
  'POST /users': { module: 'USERS', guard: 'ENFORCED' },
  'GET /users/:id': { module: 'USERS', guard: 'ENFORCED' },
};

function actualRoutes() {
  return collectRoutes(ALL_CONTROLLERS);
}

function key(r: { method: string; path: string }): string {
  return `${r.method} ${r.path}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('7.6 — every route is classified', () => {
  it('the probe finds real routes, so nothing below is vacuous', () => {
    const routes = actualRoutes();
    expect(routes.length).toBeGreaterThan(100);
    // POSITIVE CONTROL: a route we know exists, with the shape we expect.
    expect(routes.map(key)).toContain('POST /auth/login');
    expect(routes.map(key)).toContain('GET /products');
  });

  it('the classified set and the served set are identical', () => {
    // Exact sets both ways. A new route is an unclassified key; a deleted route is
    // a classification with nothing behind it. Both name themselves in the diff.
    expect(actualRoutes().map(key).sort()).toEqual(Object.keys(ROUTE_CLASSIFICATION).sort());
  });

  it('every controller file on disk is in the registry', () => {
    // The one place the inventory could go quietly incomplete: a controller that
    // exists and serves routes but is never handed to `collectRoutes`.
    const onDisk = discoverControllerFiles(API_SRC);
    expect(onDisk.length).toBeGreaterThan(0);
    expect([...REGISTERED_CONTROLLER_FILES].sort()).toEqual(onDisk);
  });

  it('the registry lists one class per registered file', () => {
    // Guards the other half: a file listed above but no class imported would make
    // its routes invisible to every assertion in this spec.
    expect(ALL_CONTROLLERS.length).toBe(REGISTERED_CONTROLLER_FILES.length);
    expect(new Set(ALL_CONTROLLERS.map((c) => c.name)).size).toBe(ALL_CONTROLLERS.length);
  });

  it('every classification names a real module or SHARED_CORE', () => {
    const known = new Set([
      'SHARED_CORE',
      'RETAIL_POS',
      'INVENTORY',
      'CUSTOMERS',
      'QUOTATIONS',
      'RETURNS',
      'EXCHANGES',
      'SUPPLIERS',
      'REPORTING',
      'USERS',
      'BRANCHES',
      'SETTINGS',
      'BRANDING',
      'QUICKBOOKS',
      'MENU_MANAGEMENT',
      'DINING',
      'TABLE_MANAGEMENT',
      'TAKEAWAY',
      'KITCHEN',
      'KITCHEN_DISPLAY',
      'ONLINE_ORDERS',
      'DELIVERY_INTEGRATIONS',
      'RESERVATIONS',
    ]);
    for (const [route, c] of Object.entries(ROUTE_CLASSIFICATION)) {
      expect({ route, known: known.has(c.module) }).toEqual({ route, known: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The classification matches reality
// ─────────────────────────────────────────────────────────────────────────────

describe('7.6 — a route marked ENFORCED really is guarded', () => {
  it('every ENFORCED route carries the module it is classified with', () => {
    const mismatches = actualRoutes()
      .filter((r) => ROUTE_CLASSIFICATION[key(r)]?.guard === 'ENFORCED')
      .filter((r) => r.requiredModule !== ROUTE_CLASSIFICATION[key(r)]!.module)
      .map((r) => `${key(r)}: metadata=${r.requiredModule} classified=${ROUTE_CLASSIFICATION[key(r)]!.module}`);
    expect(mismatches).toEqual([]);
  });

  it('every route NOT marked ENFORCED genuinely carries no module guard', () => {
    // The other direction. Without it, marking everything `shared-core` would pass.
    const unexpected = actualRoutes()
      .filter((r) => ROUTE_CLASSIFICATION[key(r)]?.guard !== 'ENFORCED')
      .filter((r) => r.requiredModule !== null)
      .map((r) => `${key(r)} carries ${r.requiredModule}`);
    expect(unexpected).toEqual([]);
  });

  it('both states are populated — the split is real, not one-sided', () => {
    const routes = actualRoutes();
    const guarded = routes.filter((r) => r.requiredModule !== null);
    const open = routes.filter((r) => r.requiredModule === null);
    // If either were empty, one of the two assertions above would be vacuous.
    expect(guarded.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    expect(guarded.length + open.length).toBe(routes.length);
  });

  it('no @Public() route carries a module guard', () => {
    // ModuleAccessGuard denies these outright (no authenticated tenant), so a
    // module guard on a public route is a wiring mistake that breaks the route.
    const broken = actualRoutes()
      .filter((r) => r.isPublic && r.requiredModule !== null)
      .map(key);
    expect(broken).toEqual([]);
    // POSITIVE CONTROL: there ARE public routes, so this is a real check.
    expect(actualRoutes().filter((r) => r.isPublic).map(key)).toContain('GET /quickbooks/callback');
  });

  it('the QuickBooks OAuth callback is public and ungated, but its siblings are gated', () => {
    const routes = actualRoutes();
    const callback = routes.find((r) => key(r) === 'GET /quickbooks/callback')!;
    expect(callback.isPublic).toBe(true);
    expect(callback.requiredModule).toBeNull();

    const status = routes.find((r) => key(r) === 'GET /quickbooks/status')!;
    expect(status.isPublic).toBe(false);
    expect(status.requiredModule).toBe('QUICKBOOKS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Documentation stays in step
// ─────────────────────────────────────────────────────────────────────────────

describe('7.6 — the matrix document matches the code', () => {
  it('records the same route and guard totals', () => {
    const doc = readFileSync(MATRIX_DOC, 'utf8');
    const routes = actualRoutes();
    const enforced = routes.filter((r) => r.requiredModule !== null).length;

    expect(doc).toContain(`Total routes: ${routes.length}`);
    expect(doc).toContain(`Module-guarded routes: ${enforced}`);
    expect(doc).toContain(`Ungated routes: ${routes.length - enforced}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('7.6 — the matrix tripwires can actually fail', () => {
  it('an unclassified new route would be detected', () => {
    const served = actualRoutes().map(key).sort();
    const withNew = [...served, 'POST /restaurant/tables'].sort();
    expect(withNew).not.toEqual(served);
    expect(() => expect(withNew).toEqual(Object.keys(ROUTE_CLASSIFICATION).sort())).toThrow();
  });

  it('a guard silently removed from a gated route would be detected', () => {
    const real = actualRoutes().find((r) => key(r) === 'GET /suppliers')!;
    expect(real.requiredModule).toBe('SUPPLIERS');

    const weakened = { ...real, requiredModule: null };
    expect(weakened).not.toEqual(real);
    expect(() => expect(weakened.requiredModule).toBe('SUPPLIERS')).toThrow();
  });

  it('a guard added to a public route would be detected', () => {
    const real = actualRoutes().find((r) => r.isPublic && r.requiredModule === null)!;
    const broken = { ...real, requiredModule: 'QUICKBOOKS' as const };
    const offenders = [broken].filter((r) => r.isPublic && r.requiredModule !== null).map(key);
    expect(offenders.length).toBe(1);
  });

  it('a controller left out of the registry would be detected', () => {
    const onDisk = discoverControllerFiles(API_SRC);
    const missing = [...REGISTERED_CONTROLLER_FILES].sort().filter((f) => f !== 'health');
    expect(missing).not.toEqual(onDisk);
    expect(() => expect(missing).toEqual(onDisk)).toThrow();
  });
});
