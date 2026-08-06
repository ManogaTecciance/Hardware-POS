# Hardware POS

A cashier sales front-end for hardware retail, built to work alongside
**QuickBooks Online** — which remains the inventory and accounting source of truth.

The POS pulls products, prices, and stock from QuickBooks, and sends completed
sales, invoices, and payments back to QuickBooks. The client continues to use
QuickBooks for inventory, accounting, and financial reports.

> **Status:** Production-oriented. Implemented: authentication and roles,
> products and categories, customers, suppliers, POS checkout with discount
> approval and credit limits, payments, returns and refunds, quotations with
> revisions, receipts and A4 documents, settings, dashboards, audit logging,
> and a live QuickBooks Online integration (OAuth, product/party sync, and a
> queued outbound sale/return push).
>
> In progress on `feature/restaurant-pos`: making QuickBooks optional behind
> provider abstractions and adding a configurable Restaurant business profile.
> See [docs/restaurant-pos/](docs/restaurant-pos/).

## Monorepo structure

```
hardware-pos/
├── apps/
│   ├── web/        Next.js + TypeScript cashier front-end
│   └── api/        NestJS + TypeScript backend & sync orchestration
├── packages/
│   ├── database/   Prisma schema + client (PostgreSQL)
│   └── shared/     Shared TypeScript types, enums, constants
└── docs/           Project documentation
```

| Package                 | Name                      | Stack                    |
| ----------------------- | ------------------------- | ------------------------ |
| `apps/web`              | `@hardware-pos/web`       | Next.js 15, React 19, TS |
| `apps/api`              | `@hardware-pos/api`       | NestJS 11, TS            |
| `packages/database`     | `@hardware-pos/database`  | Prisma 6, PostgreSQL     |
| `packages/shared`       | `@hardware-pos/shared`    | TypeScript               |

Tooling: **pnpm workspaces** + **Turborepo**.

## Quick start

```bash
pnpm install
docker compose up -d                                        # PostgreSQL 16 on :5432
cp apps/api/.env.example apps/api/.env                      # set a real JWT_SECRET
cp apps/web/.env.example apps/web/.env
cp packages/database/.env.example packages/database/.env
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web → http://localhost:3000
- API → http://localhost:4000/v1

Seeded logins — two workspaces with different business profiles:

| Workspace | Sign in with | Profile |
| --------- | ------------ | ------- |
| `demo` | `owner@hardwarepos.test` / `password123`, Manager PIN `2222`, Cashier PIN `1111` | Tile Shop, QuickBooks inventory and accounting |
| `resto-demo` | `owner@axlorestaurant.test` / `password123`, Cashier PIN `3333` | Restaurant, local inventory, no accounting |

The workspace field is optional while an email is unique across tenants. **PIN
sign-in requires the device to be commissioned first** — sign in once with an email
and password in that browser, after which the PIN box works for that tenant and
keeps working across sign-out.

See [docs/getting-started.md](./docs/getting-started.md) for full setup, and
[docs/architecture.md](./docs/architecture.md) for the system design.

## Scripts

| Command          | Description                          |
| ---------------- | ------------------------------------ |
| `pnpm dev`       | Run web + api in watch mode          |
| `pnpm dev:web`   | Run only the Next.js front-end       |
| `pnpm dev:api`   | Run only the NestJS API              |
| `pnpm build`     | Build all packages                   |
| `pnpm lint`      | Lint all packages                    |
| `pnpm typecheck` | Type-check all packages              |
| `pnpm test`      | Run tests                            |
| `pnpm format`    | Format with Prettier                 |
| `pnpm db:generate` / `db:migrate` / `db:studio` | Prisma helpers    |

## License

Proprietary — all rights reserved.
