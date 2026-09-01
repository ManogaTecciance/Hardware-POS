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
    expect(s.documents.showSku).toBe(true);
    expect(s.currency).toBeDefined();
  });

  it('ships the calibrated roll geometry as the default (D99)', () => {
    const svc = new SettingsService(fakePrisma() as any);
    const d = svc.getSettings(TENANT).documents;
    /*
     * The Xprinter XP-365B's numbers. The LEFT inset is the one that matters:
     * at 0 the bill printed correctly from Chrome and lost its first
     * characters from Edge, which re-fits the page against the driver's stock
     * and takes the overflow off both edges.
     */
    expect(d.billPaperWidthMm).toBe(78);
    expect(d.billLeftInsetMm).toBe(3);
    expect(d.billRightInsetMm).toBe(5);
    expect(d.billFitToContent).toBe(true);
    // NEGATIVE, named: zero on either side is the shape that clipped Edge.
    expect(d.billLeftInsetMm).toBeGreaterThan(0);
    expect(d.billRightInsetMm).toBeGreaterThan(0);
  });

  it('gives an existing tenant the geometry without a backfill (D99)', async () => {
    /*
     * No Prisma migration: the settings are a `Json` blob, and the defaults are
     * merged UNDER whatever a tenant already stored. A workspace configured
     * before D99 must come back with the geometry on its next read, or every
     * existing restaurant keeps printing the layout that clipped.
     */
    const prisma = fakePrisma();
    prisma.rows.push({
      id: 's_legacy',
      tenantId: TENANT,
      branchId: null,
      data: { documents: { companyName: 'Praneetha', accentColor: '#006c68' } },
    });
    const svc = new SettingsService(prisma as any);
    await svc.onModuleInit?.();

    const d = svc.getSettings(TENANT).documents;
    expect(d.billLeftInsetMm).toBe(3);
    expect(d.billPaperWidthMm).toBe(78);
    // …and what the tenant had actually set is still theirs.
    expect(d.companyName).toBe('Praneetha');
  });

  it('round-trips a measured geometry without disturbing the rest', async () => {
    const svc = new SettingsService(fakePrisma() as any);
    const next = await svc.updateSettings(TENANT, {
      documents: { billLeftInsetMm: 6, billPaperWidthMm: 58 },
    });
    expect(next.documents.billLeftInsetMm).toBe(6);
    expect(next.documents.billPaperWidthMm).toBe(58);
    // The inset the operator did NOT touch keeps its value — a merge that
    // reset the group would pass both assertions above.
    expect(next.documents.billRightInsetMm).toBe(5);
    expect(next.documents.showSku).toBe(true);
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
    // …untouched fields keep their defaults
    expect(next.documents.showSku).toBe(true);
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
