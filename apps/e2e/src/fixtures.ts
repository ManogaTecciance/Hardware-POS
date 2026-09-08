import { test as base, expect } from '@playwright/test';

import { Api, apiLogin, apiPinLogin, SEED } from './api';

/**
 * Worker-scoped API clients per role. UI specs additionally opt into a saved
 * storage state via `test.use({ storageState: AUTH.owner })`.
 */
type Fixtures = Record<never, never>;

interface WorkerFixtures {
  ownerApi: Api;
  salespersonApi: Api;
  accountantApi: Api;
  managerApi: Api;
  cashierApi: Api;
}

import * as path from 'node:path';

export const AUTH = {
  owner: path.resolve(__dirname, '../.auth/owner.json'),
  accountant: path.resolve(__dirname, '../.auth/accountant.json'),
  manager: path.resolve(__dirname, '../.auth/manager.json'),
  cashier: path.resolve(__dirname, '../.auth/cashier.json'),
} as const;

export const test = base.extend<Fixtures, WorkerFixtures>({
  ownerApi: [
    async ({}, use) => {
      const auth = await apiLogin(SEED.owner.email, SEED.owner.password);
      await use(await Api.create(auth));
    },
    { scope: 'worker' },
  ],
  salespersonApi: [
    async ({}, use) => {
      const auth = await apiLogin(SEED.salesperson.email, SEED.salesperson.password);
      await use(await Api.create(auth));
    },
    { scope: 'worker' },
  ],
  accountantApi: [
    async ({}, use) => {
      const auth = await apiLogin(SEED.accountant.email, SEED.accountant.password);
      await use(await Api.create(auth));
    },
    { scope: 'worker' },
  ],
  managerApi: [
    async ({}, use) => {
      const auth = await apiPinLogin(SEED.managerPin);
      await use(await Api.create(auth));
    },
    { scope: 'worker' },
  ],
  cashierApi: [
    async ({}, use) => {
      const auth = await apiPinLogin(SEED.cashierPin);
      await use(await Api.create(auth));
    },
    { scope: 'worker' },
  ],
});

export { expect };

/** Skip helper: mark a case unautomatable in this environment with a reason. */
export function envSkip(reason: string) {
  test.skip(true, reason);
}
