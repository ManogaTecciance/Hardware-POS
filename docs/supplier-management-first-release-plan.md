# Supplier Management — First Release Plan

> Status: in progress · Branch: `feature/supplier-management` · Module owner: Suppliers
> Scope: operational supplier management inside the existing AxloPOS web app.

## 1. Goal

Give business owners, purchasing staff, inventory staff, and accountants a clear,
operational place to manage suppliers — contacts, product relationships, purchasing
activity, documents/notes, and QuickBooks vendor mapping — without requiring advanced
technical knowledge. QuickBooks Online stays the source of truth for supplier
financials; AxloPOS owns operational supplier data.

## 2. Existing architecture (audited)

Monorepo (`turbo` + `pnpm`), Node ≥ 20.

- **Web** — `apps/web`, Next.js 15 App Router, React 19, Tailwind CSS v4, TypeScript.
  - App routes live under `apps/web/src/app/(app)/<feature>`. Route group `(app)`
    is auth-gated by `Protected` and wrapped by `Sidebar` + `Header` in
    [`(app)/layout.tsx`](../apps/web/src/app/(app)/layout.tsx). The shell is
    viewport-locked; `main` owns the only vertical scroll (no page-level horizontal
    scroll is allowed).
  - **Data fetching** is a thin custom client — [`lib/api.ts`](../apps/web/src/lib/api.ts)
    (`api.get/post/patch/del`, bearer token + `x-tenant-id`, `{ data }` unwrap,
    single-flight refresh-on-401). No React Query; feature pages use
    `useEffect` + local state with a `cancelled` guard and debounced search
    (see [`customers/page.tsx`](../apps/web/src/app/(app)/customers/page.tsx)).
  - **Feature services** are typed adapters per domain, e.g.
    [`lib/customers-api.ts`](../apps/web/src/lib/customers-api.ts),
    [`lib/products-api.ts`](../apps/web/src/lib/products-api.ts) — they own the
    `Api*` → view-model mapping (e.g. `Decimal` strings → `number`).
  - **Auth / permissions** — [`lib/auth.tsx`](../apps/web/src/lib/auth.tsx)
    (`useAuth().hasPermission`) mirrors [`lib/permissions.ts`](../apps/web/src/lib/permissions.ts)
    (`Permission`, `ROLE_PERMISSIONS`, roles: OWNER, ADMIN, MANAGER, CASHIER,
    ACCOUNTANT).
  - **Navigation** is data-driven — [`lib/nav.ts`](../apps/web/src/lib/nav.ts)
    `NAV_GROUPS` (grouped, permission-gated).
  - **UI primitives** — `components/ui/*`: `Button`/`buttonVariants` (CVA, touch
    heights h-9/h-11/h-14), `Card`, `Badge` (neutral/primary/accent/success/
    warning/danger/info), `Dialog` (Escape/overlay close), `Input`, `Select`,
    `Textarea`, `Label`, `Switch`, `SearchSelect`, `ChipRow`, `Tooltip`.
    Shared `PageHeader`.
  - **Design tokens** — [`app/globals.css`](../apps/web/src/app/globals.css):
    Axlo semantic tokens mapped to Tailwind utilities (`bg-primary`, `bg-surface`,
    `bg-card`, `bg-canvas`, `text-foreground`, `text-muted-foreground`,
    `border-border`, `bg-brand-50`, `text-brand-700`, `*-soft`, `ring-ring`),
    with light `:root` + `[data-theme='dark']` overrides. Components consume
    utilities, never raw hex.
  - **Money/format** — `formatMoney` (LKR) via `@hardware-pos/shared` `formatCurrency`.
  - **QuickBooks (UI)** — `components/quickbooks/sync-badge.tsx` (`SyncState`),
    `lib/quickbooks.tsx`, `lib/quickbooks-api.ts`.
  - **Tests** — Vitest, **node environment, pure-logic only** (no DOM/RTL);
    see `lib/dashboard/chart-tokens.test.ts`. Our tests follow suit (adapters,
    validation, view-model transforms, lifecycle rules).
- **API** — `apps/api`, NestJS + Prisma. Modules under `src/modules/*`
  (customers, products, quickbooks, documents, audit-log, …). **No `suppliers`
  module exists yet.**

### Reusable components / utilities

`PageHeader`, `Button`/`buttonVariants`, `Card*`, `Badge`, `Dialog`, `Input`,
`Select`, `Textarea`, `Label`, `Switch`, `SearchSelect`, `ChipRow`, `Tooltip`,
`SyncBadge`, `formatMoney`, `cn`, `useAuth`, `Permission`, `api`, product/category
services (for product-linking and category chips).

## 3. Source-of-truth model

- **QuickBooks Online owns** vendor financial identity, bills, payments, A/P
  balance, reports, transaction history. Shown **read-only** in AxloPOS and clearly
  labelled `Financial data from QuickBooks Online`.
- **AxloPOS owns** contacts, product relationships / supplier SKUs, categories
  supplied, MOQ, lead times, operational notes, documents, supplier + preferred
  status, purchasing observations.
- One-to-one mapping: **AxloPOS Supplier ↔ QuickBooks Vendor**. AxloPOS never
  silently creates, remaps, or overwrites QuickBooks financial records.

## 4. Proposed page architecture (routes)

Follows existing conventions (route group `(app)`, `[id]` dynamic segment):

- `/suppliers` — list
- `/suppliers/new` — create
- `/suppliers/[supplierId]` — profile (tabs)
- `/suppliers/[supplierId]/edit` — edit

Nav item **Suppliers** (icon `Truck`) added to the `Catalog` group in `nav.ts`,
between Products and Customers, gated by `supplier:read`.

## 5. Data ownership & API boundary

There is **no backend supplier module yet**. Per the frontend-adapter guidance:

- A single typed adapter, `lib/suppliers/suppliers-api.ts`, is the only place that
  talks to the network. It targets the *intended* REST shape (`/suppliers`,
  `/suppliers/:id`, `/suppliers/:id/contacts`, `.../products`, `.../documents`,
  `.../notes`, `.../quickbooks-mapping`, lifecycle endpoints).
- Until those endpoints exist, the adapter falls back to an **isolated,
  clearly-labelled development mock** (`lib/suppliers/mock-data.ts`), gated behind
  `NEXT_PUBLIC_SUPPLIERS_MOCK` (defaults on only in development). Demo data is
  visibly labelled in the UI (a "Demo data" banner). Production builds with the
  flag off show **safe empty states**, never fabricated numbers.
- View models are computed in the adapter/view-model layer, **never** accounting
  balances inside presentational components.

### View models

`SupplierListItem`, `SupplierProfileViewModel`, `SupplierContactViewModel`,
`SupplierProductLinkViewModel`, `SupplierPurchaseHistoryViewModel`,
`SupplierFinancialSummaryViewModel`, `SupplierQuickBooksMappingViewModel`.

## 6. CRUD & lifecycle rules

- States: **ACTIVE**, **INACTIVE**, **BLOCKED**, **DRAFT**.
- Deactivate / Block preserve all history; reactivation restores ACTIVE.
- Block requires a reason and shows a warning banner; new purchasing is prevented
  unless the user has approval permission.
- **Permanent delete** is allowed only when the supplier has no purchases, no POs,
  no QuickBooks mapping, no financial records, no linked products, no documents,
  and no audit dependencies (`canDeletePermanently()` in the domain layer). The
  delete dialog names the supplier, explains it can't be undone, and offers
  Deactivate instead when blocked.

## 7. Permission rules

New permissions (mirrored in `lib/permissions.ts`, enforced server-side when the
backend lands):

- `supplier:read`, `supplier:manage`, `supplier:delete`,
  `supplier:bank:view`, `supplier:financials:read`, `supplier:qb:map`.

Role map:

| Role | read | manage | delete | bank | financials | qb:map |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| Owner / Admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manager (Purchasing) | ✓ | ✓ | — | — | ✓ | ✓ |
| Accountant | ✓ | — | — | — | ✓ | ✓ |
| Inventory (mapped to CASHIER+? see note) | ✓ | limited | — | — | — | — |
| Cashier | — | — | — | — | — | — |

> The app ships 5 roles (no distinct Inventory role). Cashier gets **no** supplier
> access by default. Purchasing Officer/Manager → MANAGER; Accountant → ACCOUNTANT.
> Gating uses `hasPermission`, not hardcoded role names, so a future Inventory role
> slots in by permission set alone.

## 8. Responsive strategy

- Desktop: full table, sticky header, compact rows.
- Laptop: hide lower-priority columns (products, QB, last purchase).
- Landscape tablet: compact rows / expandable detail.
- Portrait tablet & mobile: rows become supplier **cards**; forms single-column;
  profile tabs scroll inside their own `ChipRow`-style container; destructive
  actions live in a More menu. No horizontal page scroll (table wrapped in
  `overflow-x-auto`, card fallback below the `lg` breakpoint).

## 9. Accessibility strategy (WCAG 2.2 AA)

44px touch targets (existing h-11 primitives), visible focus (`ring-ring`),
keyboard nav, correct heading hierarchy, labelled fields with error association
(`aria-describedby` + `aria-invalid`), status conveyed by icon+text not colour
alone, dialog focus trap + restore, accessible tables (`<th scope>`), reduced-motion
respect, icon-only actions get accessible names, confirmation dialogs spell out
consequences.

## 10. Limitations

- **API**: no backend supplier module; all data flows through the adapter, which
  uses an isolated dev mock until endpoints exist. Real QuickBooks vendor matching
  is stubbed — match confidence is only shown where the mock provides it and is
  labelled as illustrative.
- **Mock data** is development-only, isolated to `lib/suppliers/mock-data.ts`,
  visibly labelled, and never mixed silently with live data.
- **Financials** are read-only and, without live QuickBooks vendor data, render as
  "not connected / unavailable" empty states rather than numbers.
- **Purchase orders**: no PO subsystem yet → "Create Purchase Order" actions are
  hidden and Purchase History shows a production-safe empty state + backend TODO.
- File upload uses the intended documents endpoint via the adapter; in mock mode
  uploads are simulated in-memory and labelled (no large files in LocalStorage).

## 11. Testing approach

Vitest, node env, pure logic:

- validation (`validateSupplierDraft`, contact validation),
- view-model transforms (`toSupplierListItem`, financial/QB mapping derivations),
- lifecycle rules (`canDeletePermanently`, allowed transitions),
- permission derivation (role → supplier capabilities),
- mock adapter shape (list/filter/sort/paginate).

Then: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (web).

## 12. Implementation order

Plan → permissions/nav → data layer (types/format/mock/adapter) → shared UI →
list → form (new/edit) → profile + tabs → QB mapping + lifecycle dialogs → tests →
typecheck/lint/test/build → commit to `feature/supplier-management` (no push, no merge).
