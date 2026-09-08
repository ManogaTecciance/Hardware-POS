import { SettingsService } from './settings.service';

/** Minimal in-memory stand-in for the parts of PrismaService the service uses. */
function fakePrisma() {
  const rows: { id: string; tenantId: string; branchId: string | null; data: unknown }[] = [];
  return {
    rows,
    tenantSettings: {
      findMany: jest.fn(async () => rows.filter((r) => r.branchId === null)),
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.tenantId === where.tenantId && r.branchId === (where.branchId ?? null)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `s_${rows.length}`, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].tenantId === where.tenantId && rows[i].branchId === (where.branchId ?? null)) rows.splice(i, 1);
        }
        return { count: 1 };
      }),
    },
  };
}

describe('SettingsService (persistence + merge)', () => {
  const TENANT = 'tnt_1';

  it('returns code defaults for an unconfigured tenant', () => {
    const svc = new SettingsService(fakePrisma() as any);
    const s = svc.getSettings(TENANT);
    expect(s.documents.defaultPaperSize).toBe('A4');
    // FALSE since 2026-09-08: a SKU is an internal identifier and a new
    // workspace does not put it on a customer's bill. The column still
    // exists and still has its toggle; only the default moved. Updated for a
    // deliberate product change, not to make a refactor pass — the
    // distinction D16 draws.
    expect(s.documents.showSku).toBe(false);
    expect(s.currency).toBeDefined();
  });

  it('deep-merges a partial document update and persists it', async () => {
    const prisma = fakePrisma();
    const svc = new SettingsService(prisma as any);

    const next = await svc.updateSettings(TENANT, {
      documents: { accentColor: '#ff0000', showTaxColumn: false },
    });

    // changed fields applied…
    expect(next.documents.accentColor).toBe('#ff0000');
    expect(next.documents.showTaxColumn).toBe(false);
    // …untouched fields keep their defaults. What this asserts is the MERGE
    // — that a partial update does not flatten its neighbours — so the value
    // matters only in that it must equal the default, whatever that is.
    expect(next.documents.showSku).toBe(false);
    expect(next.documents.defaultPaperSize).toBe('A4');
    // persisted + served from cache on the next read
    expect(prisma.tenantSettings.create).toHaveBeenCalledTimes(1);
    expect(svc.getSettings(TENANT).documents.accentColor).toBe('#ff0000');
  });

  it('clears a nullable document field when given an empty string', async () => {
    const svc = new SettingsService(fakePrisma() as any);
    await svc.updateSettings(TENANT, { documents: { companyName: 'Acme Hardware' } });
    expect(svc.getSettings(TENANT).documents.companyName).toBe('Acme Hardware');

    const cleared = await svc.updateSettings(TENANT, { documents: { companyName: '' } });
    expect(cleared.documents.companyName).toBeNull();
  });

  it('updates an existing row instead of creating a second one', async () => {
    const prisma = fakePrisma();
    const svc = new SettingsService(prisma as any);
    await svc.updateSettings(TENANT, { documents: { logoSize: 'LARGE' } });
    await svc.updateSettings(TENANT, { documents: { logoSize: 'SMALL' } });
    expect(prisma.tenantSettings.create).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSettings.update).toHaveBeenCalledTimes(1);
    expect(prisma.rows).toHaveLength(1);
    expect(svc.getSettings(TENANT).documents.logoSize).toBe('SMALL');
  });

  it('resets to defaults and drops the stored row', async () => {
    const prisma = fakePrisma();
    const svc = new SettingsService(prisma as any);
    await svc.updateSettings(TENANT, { documents: { accentColor: '#123456' } });
    const reset = await svc.resetSettings(TENANT);
    expect(reset.documents.accentColor).toBe('#1d4ed8');
    expect(prisma.rows).toHaveLength(0);
    expect(svc.getSettings(TENANT).documents.accentColor).toBe('#1d4ed8');
  });
});
