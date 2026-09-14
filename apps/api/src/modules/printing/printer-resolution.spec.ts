import type { Prisma } from '@hardware-pos/database';

import { resolveBillPrinter, resolveStationPrinterIds } from './printing.service';

/**
 * D183 — which printer a bill or an unlinked station lands on, now that the
 * "What prints by itself" card is gone from the settings screen.
 *
 * Non-vacuous per D30: each fallback is asserted both when it should fire
 * (nothing chosen / chosen printer off) and when it must NOT (a live choice
 * wins; no printer of the role exists → nothing, never a printer of the
 * other role).
 */

type Printer = { id: string; branchId: string; role: 'KITCHEN' | 'CASHIER'; isActive: boolean; createdAt: number };

function txWith(opts: {
  printers: Printer[];
  links?: { stationId: string; printerId: string; isPrimary: boolean }[];
  defaultKitchenPrinterId?: string | null;
}): Prisma.TransactionClient {
  const printers = opts.printers;
  const matches = (p: Printer, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'id' && v && typeof v === 'object' && 'in' in (v as object)) return (v as { in: string[] }).in.includes(p.id);
      if (k === 'tenantId') return true;
      return (p as Record<string, unknown>)[k] === v;
    });
  const sorted = (where: Record<string, unknown>, orderBy?: { createdAt?: string }) => {
    const list = printers.filter((p) => matches(p, where));
    return orderBy?.createdAt === 'asc' ? [...list].sort((a, b) => a.createdAt - b.createdAt) : list;
  };
  return {
    kitchenPrinter: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown>; orderBy?: { createdAt?: string } }) => {
        const hit = sorted(args.where, args.orderBy)[0];
        return hit ? { id: hit.id } : null;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => sorted(args.where).map((p) => ({ id: p.id }))),
    },
    kitchenStationPrinter: {
      findMany: jest.fn(async (args: { where: { stationId: string } }) =>
        (opts.links ?? [])
          .filter((l) => l.stationId === args.where.stationId)
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
          .map((l) => ({ printerId: l.printerId })),
      ),
    },
    restaurantBranchConfig: {
      findUnique: jest.fn(async () => ({ defaultKitchenPrinterId: opts.defaultKitchenPrinterId ?? null })),
    },
  } as unknown as Prisma.TransactionClient;
}

const CASHIER_OLD: Printer = { id: 'c_old', branchId: 'b', role: 'CASHIER', isActive: true, createdAt: 1 };
const CASHIER_NEW: Printer = { id: 'c_new', branchId: 'b', role: 'CASHIER', isActive: true, createdAt: 2 };
const CASHIER_OFF: Printer = { id: 'c_off', branchId: 'b', role: 'CASHIER', isActive: false, createdAt: 0 };
const KITCHEN_OLD: Printer = { id: 'k_old', branchId: 'b', role: 'KITCHEN', isActive: true, createdAt: 1 };
const KITCHEN_NEW: Printer = { id: 'k_new', branchId: 'b', role: 'KITCHEN', isActive: true, createdAt: 2 };
const KITCHEN_OFF: Printer = { id: 'k_off', branchId: 'b', role: 'KITCHEN', isActive: false, createdAt: 0 };

describe('resolveBillPrinter', () => {
  const input = (chosenId: string | null) => ({ tenantId: 't', branchId: 'b', chosenId });

  it('a chosen, active printer wins even if it is not the oldest', async () => {
    const tx = txWith({ printers: [CASHIER_OLD, CASHIER_NEW] });
    await expect(resolveBillPrinter(tx, input('c_new'))).resolves.toEqual({ id: 'c_new' });
  });

  it('nothing chosen → the first active cashier printer, not a kitchen one', async () => {
    const tx = txWith({ printers: [KITCHEN_OLD, CASHIER_NEW, CASHIER_OLD] });
    await expect(resolveBillPrinter(tx, input(null))).resolves.toEqual({ id: 'c_old' });
  });

  it('a chosen printer that is off falls back to the first active one', async () => {
    const tx = txWith({ printers: [CASHIER_OFF, CASHIER_NEW] });
    await expect(resolveBillPrinter(tx, input('c_off'))).resolves.toEqual({ id: 'c_new' });
  });

  it('no active cashier printer → null, even with kitchen printers present', async () => {
    const tx = txWith({ printers: [KITCHEN_OLD, CASHIER_OFF] });
    await expect(resolveBillPrinter(tx, input(null))).resolves.toBeNull();
  });
});

describe('resolveStationPrinterIds', () => {
  const input = { tenantId: 't', branchId: 'b', stationId: 'grill' };

  it('linked printers win, primary first, and the fallback does not run', async () => {
    const tx = txWith({
      printers: [KITCHEN_OLD, KITCHEN_NEW],
      links: [
        { stationId: 'grill', printerId: 'k_new', isPrimary: false },
        { stationId: 'grill', printerId: 'k_old', isPrimary: true },
      ],
    });
    await expect(resolveStationPrinterIds(tx, input)).resolves.toEqual(['k_old', 'k_new']);
  });

  it('nothing linked, a default chosen → the default', async () => {
    const tx = txWith({ printers: [KITCHEN_OLD, KITCHEN_NEW], defaultKitchenPrinterId: 'k_new' });
    await expect(resolveStationPrinterIds(tx, input)).resolves.toEqual(['k_new']);
  });

  it('nothing linked, nothing chosen → the first active kitchen printer', async () => {
    const tx = txWith({ printers: [CASHIER_OLD, KITCHEN_NEW, KITCHEN_OLD, KITCHEN_OFF] });
    await expect(resolveStationPrinterIds(tx, input)).resolves.toEqual(['k_old']);
  });

  it('linked printer off and nothing chosen → the fallback, not the off one', async () => {
    const tx = txWith({
      printers: [KITCHEN_OFF, KITCHEN_NEW],
      links: [{ stationId: 'grill', printerId: 'k_off', isPrimary: true }],
    });
    await expect(resolveStationPrinterIds(tx, input)).resolves.toEqual(['k_new']);
  });

  it('no active kitchen printer at all → [] (never the cashier printer)', async () => {
    const tx = txWith({ printers: [CASHIER_OLD, KITCHEN_OFF] });
    await expect(resolveStationPrinterIds(tx, input)).resolves.toEqual([]);
  });
});
