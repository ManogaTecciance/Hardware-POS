/**
 * Manager-PIN discount approval through its security boundary,
 * POST /discounts/approve.
 *
 * This coverage moved here from Playwright (POS-018/019/021) on 2026-08-17:
 * the dev seed no longer creates a MANAGER user (the hardware template
 * staffs an Owner, an owner-equivalent Salesperson and Cashiers, D108), but
 * the manager tier itself is live — the
 * enum drives approval authority and the production pilot has managers — so
 * the cap rule needs a home where the fixture can own its users. The
 * integration fixtures keep a MANAGER (PIN 1234) and CASHIER (PIN 5678).
 *
 * D30 both ways: the same approver PIN is shown approving within the cap and
 * refused beyond it, so neither test can pass through a stub that always
 * answers one way.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import {
  CASHIER_PIN,
  MANAGER_PIN,
  seedTileShopWithQuickBooks,
  type SeededTenant,
} from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';
import * as bcrypt from 'bcryptjs';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  await http.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await linkUsersToRoles(prisma, tile.tenantId);
});

const approve = (pin: string, discountValue: number) =>
  http.request<{ approved: boolean; approvalToken?: string }>('POST', '/discounts/approve', {
    token: http.tokenFor({
      userId: tile.cashierId,
      tenantId: tile.tenantId,
      role: 'CASHIER',
      activeBranchId: tile.branchId,
    }),
    body: { managerPin: pin, productId: '__order__', discountType: 'PERCENTAGE', discountValue },
  });

describe('POST /discounts/approve — the owner-level approver (D108)', () => {
  /*
   * Approval decides on the ENUM (`getRoleDiscountLimit(approver.role)`), not
   * on the role row, so the seeding work proves nothing here; and the demo
   * salesperson deliberately has no PIN. This is the one place the owner's
   * "no ceiling" is exercised for the owner-equivalent: a value the manager
   * tier refuses, approved.
   */
  const SALESPERSON_PIN = '4321';
  beforeEach(async () => {
    await prisma.user.create({
      data: {
        id: 'usr_tile_salesperson',
        tenantId: tile.tenantId,
        branchId: tile.branchId,
        role: 'SALESPERSON',
        name: 'Fixture Salesperson',
        email: 'salesperson@tile.test',
        pinHash: bcrypt.hashSync(SALESPERSON_PIN, 4),
      },
    });
  });

  it('a salesperson PIN approves beyond the manager cap — no ceiling, like the owner', async () => {
    const res = await approve(SALESPERSON_PIN, 50);
    expect(res.status).toBe(200);
    expect(res.data.approved).toBe(true);
    expect(res.data.approvalToken).toBeTruthy();
    // The token names who approved, and it is the salesperson, not a manager
    // who happened to share the PIN space.
    const payload = http.jwt.decode(res.data.approvalToken!) as { approverRole?: string };
    expect(payload.approverRole).toBe('SALESPERSON');

    // NEGATIVE — the same value is refused for the manager tier, so the 200
    // above is the ceiling talking, not an approve-anything stub.
    const manager = await approve(MANAGER_PIN, 50);
    expect(manager.status).toBe(200);
    expect(manager.data.approved).toBe(false);
    // A refusal carries an explicit null token — never a mintable one.
    expect(manager.data.approvalToken ?? null).toBeNull();
  });
});

describe('POST /discounts/approve — the manager cap', () => {
  it('a manager PIN approves a discount within the MANAGER limit', async () => {
    const res = await approve(MANAGER_PIN, 10);
    expect(res.status).toBe(200);
    expect(res.data.approved).toBe(true);
    expect(res.data.approvalToken).toBeTruthy();
  });

  it('the SAME manager PIN is refused beyond the 15% MANAGER cap', async () => {
    const res = await approve(MANAGER_PIN, 25);
    expect(res.status).toBe(200);
    expect(res.data.approved).toBe(false);
    // A refusal carries an explicit null token — never a mintable one.
    expect(res.data.approvalToken ?? null).toBeNull();
  });

  it('a cashier PIN cannot approve at all — no cap check is reached', async () => {
    const res = await approve(CASHIER_PIN, 10);
    // The cashier lacks DISCOUNT_APPROVE, so even a within-cap value is
    // refused: authority first, then the cap.
    expect(res.status).toBe(200);
    expect(res.data.approved).toBe(false);
  });

  it('an unknown PIN is a 401, not a silent rejection', async () => {
    const res = await approve('0000', 10);
    expect(res.status).toBe(401);
  });
});
