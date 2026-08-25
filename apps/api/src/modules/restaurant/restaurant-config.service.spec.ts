import { PrismaService } from '../../prisma/prisma.service';
import { RestaurantConfigService } from './restaurant-config.service';

/**
 * D97 — saving one setting must not decide another.
 *
 * The defect: `RestaurantBranchConfig` is created the first time anybody saves
 * ANY branch setting, and the Charges tab (D84) sends only charge fields. The
 * create path filled `takeawayEnabled` with `false`, and
 * `TakeawayService.create` refuses when a row exists and says false — so
 * setting a service charge switched takeaway off, and every takeaway order
 * after it failed with "Takeaway is disabled on this branch".
 *
 * It was silent in both directions: nothing in the UI mentions takeaway, and
 * the API response nobody reads carried the change.
 */

function buildService(existing: Record<string, unknown> | null = null) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const tx = {
    restaurantBranchConfig: {
      findUnique: jest.fn(async () => existing),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { branchId: 'br_1', version: 1, updatedAt: new Date(0), ...row() };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        // `row()` LAST so the stub's Decimal-shaped fields survive whatever
        // partial `existing` the test supplied; `data` is asserted directly.
        return { branchId: 'br_1', version: 2, updatedAt: new Date(0), ...existing, ...row() };
      }),
    },
  };
  const prisma = {
    branch: { findFirst: jest.fn(async () => ({ id: 'br_1' })) },
    restaurantBranchConfig: { findUnique: jest.fn(async () => existing) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    service: new RestaurantConfigService(prisma as unknown as PrismaService),
    created,
    updated,
    prisma,
  };
}

/** The shape `toView` needs back from a write. */
function row() {
  return {
    serviceChargePercent: { toFixed: () => '0.00' },
    takeawayEnabled: true,
    dineInEnabled: true,
    defaultTicketTargetMinutes: null,
    serviceChargeChannels: ['DINE_IN'],
    serviceChargeTaxable: true,
    packagingChargeAmount: { toFixed: () => '0.00' },
  };
}

describe('D97 — creating the config row from a charges-only save', () => {
  it('leaves takeaway ENABLED, because nobody asked to turn it off', async () => {
    const { service, created } = buildService(null);

    // Exactly what the Charges tab sends: charges, and nothing else.
    await service.update('tnt', 'br_1', {
      serviceChargePercent: 10,
      serviceChargeChannels: ['DINE_IN'],
      serviceChargeTaxable: true,
      packagingChargeAmount: 0,
      expectedVersion: 0,
    });

    expect(created).toHaveLength(1);
    expect(created[0]!.takeawayEnabled).toBe(true);
    // Paired with dine-in, which always had this right — the two channels must
    // behave the same way, and their asymmetry is what hid the bug.
    expect(created[0]!.dineInEnabled).toBe(true);
    // …and the charge the caller DID ask for is still applied, so this is not
    // passing on a write that never happened.
    expect(String(created[0]!.serviceChargePercent)).toContain('10');
  });

  it('still honours an explicit refusal — the flag is not decorative', async () => {
    const { service, created } = buildService(null);

    await service.update('tnt', 'br_1', { takeawayEnabled: false, expectedVersion: 0 });

    // NEGATIVE half of the pair above. A "fix" that hard-coded true would pass
    // the first test and break the feature the column exists for.
    expect(created[0]!.takeawayEnabled).toBe(false);
  });

  it('an update never touches a channel the caller did not mention', async () => {
    const { service, updated } = buildService({ version: 1, takeawayEnabled: true });

    await service.update('tnt', 'br_1', { serviceChargePercent: 12, expectedVersion: 1 });

    expect(updated).toHaveLength(1);
    // `undefined` is Prisma's "leave it alone". Anything else here would be the
    // create-path bug wearing a different hat.
    expect(updated[0]!.takeawayEnabled).toBeUndefined();
    expect(updated[0]!.dineInEnabled).toBeUndefined();
  });

  it('an unconfigured branch REPORTS takeaway as enabled, matching what the server does', async () => {
    const { service } = buildService(null);

    const view = await service.get('tnt', 'br_1');

    /*
     * This is the assertion that ties the two halves together.
     * `TakeawayService.create` refuses only when a row EXISTS and says false —
     * so a branch with no row takes takeaway orders. The view used to report
     * `false` for that same branch, describing a restriction the server does
     * not apply. A screen built on that answer would disable a working button.
     */
    expect(view.takeawayEnabled).toBe(true);
    expect(view.dineInEnabled).toBe(true);
  });
});
