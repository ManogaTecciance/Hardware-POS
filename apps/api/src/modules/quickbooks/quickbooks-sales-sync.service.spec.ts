import { QuickBooksSalesSyncService } from './quickbooks-sales-sync.service';

/**
 * The invoice date a POS sale carries must survive into the QuickBooks document,
 * otherwise a backdated sale is filed on the day it was keyed in — the one thing
 * backdating exists to prevent. `buildDocumentBody` is private, so reach it the
 * way the sync path does and assert on the wire body it produces.
 */
type BodyBuilder = (
  sale: unknown,
  lines: unknown[],
  customerRef: unknown,
  txnDate: string,
) => { TxnDate?: string; DocNumber?: string; CustomerRef?: unknown };

type TxnDateFn = (tenantId: string, sale: unknown) => string;

const TZ = 'Asia/Colombo';

/** A settings stand-in reporting the shop timezone the sync should file under. */
const settingsStub = { getSettings: () => ({ timezone: TZ }) } as never;

function service() {
  return new QuickBooksSalesSyncService(
    null as never,
    null as never,
    null as never,
    null as never,
    settingsStub,
    null as never, // customers service — unused by the date-building path
  );
}

function buildBody(sale: Record<string, unknown>) {
  const svc = service();
  const full = { saleNumber: 'S-000001', taxAmount: 0, ...sale };
  const txnDate = (svc as unknown as { txnDate: TxnDateFn }).txnDate.call(svc, 't1', full);
  const build = (svc as unknown as { buildDocumentBody: BodyBuilder }).buildDocumentBody.bind(svc);
  return build(full, [], null, txnDate);
}

describe('QuickBooks sales sync — TxnDate', () => {
  it('files the document under the sale’s invoice date, not today', () => {
    const body = buildBody({
      completedAt: new Date('2026-08-01T06:30:00Z'),
      createdAt: new Date(),
    });
    expect(body.TxnDate).toBe('2026-08-01');
  });

  it('falls back to createdAt when a sale has no completedAt', () => {
    const body = buildBody({ completedAt: null, createdAt: new Date('2026-03-09T06:30:00Z') });
    expect(body.TxnDate).toBe('2026-03-09');
  });

  it('reports the SHOP calendar day, which can differ from the UTC day', () => {
    // 20:30Z on 31 Jul is already 1 Aug in Colombo. Slicing the ISO string — or
    // reading the server's own zone — would file this under the wrong day.
    const body = buildBody({
      completedAt: new Date('2026-07-31T20:30:00Z'),
      createdAt: new Date(),
    });
    expect(body.TxnDate).toBe('2026-08-01');
  });

  it('sends a bare calendar date with no time component', () => {
    const body = buildBody({
      completedAt: new Date('2026-12-25T08:05:00Z'),
      createdAt: new Date(),
    });
    expect(body.TxnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('still carries the document number alongside the date', () => {
    const body = buildBody({
      saleNumber: 'S-000042',
      completedAt: new Date('2026-08-01T06:30:00Z'),
      createdAt: new Date(),
    });
    expect(body.DocNumber).toBe('S-000042');
    expect(body.TxnDate).toBe('2026-08-01');
  });
});
