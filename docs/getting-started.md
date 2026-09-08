# Getting Started

> Placeholder — to be expanded.

## Prerequisites

- Node.js >= 20
- pnpm >= 9 (`npm install -g pnpm`)
- PostgreSQL 14+ running locally (or a connection string to a remote instance)

## Setup

```bash
# 1. Install dependencies for every workspace
pnpm install

# 2. Start PostgreSQL (or point DATABASE_URL at an existing instance)
docker compose up -d

# 3. Create local env files from the examples.
#    apps/api/.env is what the API reads (DATABASE_URL + JWT_SECRET are required);
#    packages/database/.env is what the Prisma CLI reads;
#    apps/web/.env only needs NEXT_PUBLIC_API_URL (must include the /v1 suffix).
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
cp packages/database/.env.example packages/database/.env

# 4. Generate the Prisma client, apply migrations, and seed dev data
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

The seed creates the demo tenant with branch `brn_dev` / register `reg_dev`, ten products, and
these logins: `owner@hardwarepos.test` / `password123` (Owner), `accountant@hardwarepos.test` /
`password123`, `salesperson@hardwarepos.test` / `password123` (Salesperson),
Manager PIN `2222`, Cashier PIN `1111`.

## Running in development

```bash
# Run web + api together
pnpm dev

# Or run individually
pnpm dev:web   # Next.js  → http://localhost:3000
pnpm dev:api   # NestJS   → http://localhost:4000/v1
```

## Useful scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `pnpm build`        | Build all packages via Turborepo             |
| `pnpm lint`         | Lint all packages                            |
| `pnpm typecheck`    | Type-check all packages                      |
| `pnpm test`         | Run tests across the monorepo                |
| `pnpm format`       | Format the repo with Prettier                |
| `pnpm db:migrate`   | Run Prisma migrations (dev)                  |
| `pnpm db:studio`    | Open Prisma Studio                           |
