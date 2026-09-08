# Hardware POS — Test Documentation

This folder holds the test strategy and checklists for the Hardware POS + QuickBooks
Online integration.

| Document | Audience | Purpose |
| --- | --- | --- |
| [unit-test-plan.md](./unit-test-plan.md) | Developers | Isolated logic tests (services, helpers, guards) with mocked dependencies. |
| [integration-test-plan.md](./integration-test-plan.md) | Developers / QA eng | End-to-end API flows against a test database with a stubbed QuickBooks. |
| [manual-qa-checklist.md](./manual-qa-checklist.md) | QA / Developers | Click-through verification of the UI + API before every release. |
| [uat-checklist.md](./uat-checklist.md) | Client / Business owner | Plain-language acceptance scenarios and sign-off. |

## Test areas covered

All four documents are organised around the same 15 areas so a case can be traced across levels:

1. Login (email/password + PIN)
2. Product sync (QuickBooks → POS)
3. Product search
4. Add to cart
5. Quantity change
6. Product-wise discount
7. Manager approval
8. Cash payment
9. Card payment
10. Partial payment
11. Receipt print
12. QuickBooks Sales Receipt sync (fully paid)
13. QuickBooks Invoice + Payment sync (credit / partial)
14. Failed sync retry
15. Role access

Test-case IDs use the pattern `<LEVEL>-<AREA>-<n>`, e.g. `U-06-2` (unit, discount, case 2),
`I-12-1` (integration, sales-receipt sync, case 1).

## Architecture under test

- **apps/api** — NestJS. Controller → Service → Repository/Prisma. Global `JwtAuthGuard`,
  `RolesGuard`, `PermissionsGuard`; `ValidationPipe`; `TransformInterceptor` (`{ data }` envelope);
  `AllExceptionsFilter`.
- **apps/web** — Next.js 15 (App Router). Routes: `/login`, `/pos`, `/sales`, `/products`,
  `/customers`, `/dashboard`, `/settings`, `/quickbooks`, `/quickbooks/products`,
  `/quickbooks/sync-log`, `/quickbooks/settings`, `/quickbooks/connect`.
- **packages/database** — Prisma 6 / PostgreSQL.
- **QuickBooks** — OAuth 2.0 (encrypted tokens), product sync, sales sync (Sales Receipt /
  Invoice + Payment), and a durable sync queue drained by a background worker.

## Test environment & data

The API base path is `/v1`; responses are wrapped as `{ "data": ... }`.

Seed data (`pnpm --filter @hardware-pos/database db:seed`) — tenant `tnt_dev`:

| Role | Login | Discount limit | Notes |
| --- | --- | --- | --- |
| Owner | `owner@hardwarepos.test` / `password123` | unlimited | email/password |
| Salesperson | `salesperson@hardwarepos.test` / `password123` | unlimited | owner-equivalent; email/password |
| Accountant | `accountant@hardwarepos.test` / `password123` | n/a | email/password |
| Manager | PIN `2222` | 15% | PIN login (`x-tenant-id: tnt_dev`) |
| Cashier | PIN `1111` | 0% | PIN login (`x-tenant-id: tnt_dev`) |

Plus 10 seeded hardware products (Cement 50kg, PVC pipe, etc.) each carrying a mock
`quickbooksItemId` (`QBO-ITEM-1001`…).

### Running automated tests

```bash
pnpm --filter @hardware-pos/api test        # unit + integration (Jest)
pnpm --filter @hardware-pos/api test:watch   # watch mode
pnpm --filter @hardware-pos/api test:cov      # coverage
pnpm typecheck                                # all packages
```

### QuickBooks in tests

Never call Intuit from tests. Point the OAuth/API URLs at a local stub:
`QUICKBOOKS_TOKEN_URL`, `QUICKBOOKS_API_BASE`, `QUICKBOOKS_AUTHORIZE_URL`, `QUICKBOOKS_REVOKE_URL`.
For the worker in tests set `SYNC_WORKER_ENABLED=false` and drive the queue explicitly.

## Definition of done (per area)

- Unit: happy path + each documented error/guard branch has a case; deterministic; no network/DB.
- Integration: the flow works through HTTP with real DB rows asserted; QuickBooks stubbed.
- Manual QA: every checkbox passes on the target build; screenshots attached for UI areas.
- UAT: the client signs off each scenario or logs a defect.
