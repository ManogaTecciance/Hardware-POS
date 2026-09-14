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

Seeded logins — four workspaces, one per trade the POS serves:

| Workspace | Sign in with | Profile |
| --------- | ------------ | ------- |
| `demo` | `owner@hardwarepos.test` / `password123` (Owner), `salesperson@hardwarepos.test` / `password123` (Salesperson), Cashier PIN `1111`, approver PIN `2222` | Tile Shop, QuickBooks inventory and accounting |
| `restaurant-demo` | `restaurant.owner@axlopos.test` / `Restaurant123!`, Cashier PIN `3333` | Restaurant, local inventory, no accounting |
| `clothing-demo` | `owner@kandyapparel.test` / `Retail123!` (approver PIN `6666`), `cashier@kandyapparel.test` / `Retail123!` (approver PIN `7777`) | **Kandy Apparel** — retail clothing, local inventory, no accounting |
| `grocery-demo` | `owner@grocery.test` / `Retail123!` (approver PIN `8888`), `cashier@grocery.test` / `Retail123!` (approver PIN `9999`) | **Colombo Grocery Mart** — retail grocery, local inventory, no accounting |

### The two retail workspaces (D170)

`RETAIL` covers both trades, and they exercise opposite halves of the catalogue,
so one demo tenant could only ever show you half the product model:

| | Kandy Apparel | Colombo Grocery Mart |
|---|---|---|
| Products | 16 | 6 |
| Variants | 44 across Size and Colour | 9 |
| Sold by | the piece | **weight** — `DECIMAL` quantities in `kg` and `L` |
| Exercises | variant picker, barcodes, per-variant stock | decimal quantity entry, unit of measure |

Both carry the catalogue the Product Owner built in the app, exported rather
than invented, so the shop you open is the shop they are describing. **The
staff are theirs too** — `owner@kandyapparel.test` is the address they demo
with, so "use my login" stays true when it is written down. (`email` is unique
per TENANT, not globally, so their own workspace and the seeded one can hold the
same address.) To refresh
either after changing it:

```bash
pnpm --filter @hardware-pos/database db:export-catalogue -- \
  --slug kandy-apparel --out src/mock-clothing.ts --const CLOTHING_CATALOGUE
```

**A workspace you created by hand is on your machine only.** Sharing its
password cannot share the row; anything the team needs to sign in to has to be
seeded. If a workspace you made already holds one of these slugs, the seed says
so and leaves both alone rather than overwriting your work — rename yours to
pick up the seeded one.

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
