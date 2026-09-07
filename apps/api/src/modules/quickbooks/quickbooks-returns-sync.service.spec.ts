import { QuickBooksReturnsSyncService } from './quickbooks-returns-sync.service';
import type { ResolvedRefundTender } from './quickbooks-refund-tender.service';

/**
 * A Refund Receipt is rejected outright without `DepositToAccountRef`
 * (QuickBooks validation fault 2020) — the field the returns sync used to omit
 * whenever no account had been configured, which was every tenant. A Credit Memo
 * takes neither that field nor a tender and must not be sent either.
 *
 * `buildDocumentBody` is private, so reach it the way the sync path does and
 * assert on the wire body it produces.
 */
type BodyBuilder = (
  ret: unknown,
  lines: unknown[],
  customerRef: unknown,
  tender: ResolvedRefundTender | null,
) => Record<string, unknown>;

const TENDER: ResolvedRefundTender = {
  depositToAccountRef: { value: '20', name: 'Cash on hand' },
  paymentMethodRef: { value: '1', name: 'Cash' },
  inferred: true,
};

function service() {
  return new QuickBooksReturnsSyncService(
    null as never, // prisma
    null as never, // oauth
    null as never, // connections
    null as never, // config
    null as never, // customers
    null as never, // tender service — resolution is exercised in its own spec
  );
}

function buildBody(ret: Record<string, unknown>, tender: ResolvedRefundTender | null) {
  const svc = service();
  const full = {
    returnNumber: 'R-000002',
    taxAdjustment: 0,
    originalSale: { saleNumber: 'S-000009' },
    ...ret,
  };
  const build = (svc as unknown as { buildDocumentBody: BodyBuilder }).buildDocumentBody.bind(svc);
  return build(full, [], null, tender);
}

describe('QuickBooks returns sync — Refund Receipt tender', () => {
  it('names the account the refund is paid back from', () => {
    const body = buildBody({ quickbooksDocumentType: 'REFUND_RECEIPT' }, TENDER);
    expect(body.DepositToAccountRef).toEqual({ value: '20', name: 'Cash on hand' });
  });

  it('records the tender the refund was paid in', () => {
    const body = buildBody({ quickbooksDocumentType: 'REFUND_RECEIPT' }, TENDER);
    expect(body.PaymentMethodRef).toEqual({ value: '1', name: 'Cash' });
  });

  it('omits the tender when the company has no matching payment method', () => {
    const body = buildBody(
      { quickbooksDocumentType: 'REFUND_RECEIPT' },
      { ...TENDER, paymentMethodRef: null },
    );
    expect(body.DepositToAccountRef).toBeDefined();
    expect(body).not.toHaveProperty('PaymentMethodRef');
  });

  it('sends neither field on a Credit Memo, which accepts neither', () => {
    const body = buildBody({ quickbooksDocumentType: 'CREDIT_MEMO' }, null);
    expect(body).not.toHaveProperty('DepositToAccountRef');
    expect(body).not.toHaveProperty('PaymentMethodRef');
  });

  it('still carries the document number and the sale it reverses', () => {
    const body = buildBody({ quickbooksDocumentType: 'REFUND_RECEIPT' }, TENDER);
    expect(body.DocNumber).toBe('R-000002');
    expect(body.PrivateNote).toContain('S-000009');
  });

  it('sends tax only when the return actually adjusts it', () => {
    const taxed = buildBody(
      { quickbooksDocumentType: 'REFUND_RECEIPT', taxAdjustment: 150 },
      TENDER,
    );
    expect(taxed.TxnTaxDetail).toEqual({ TotalTax: 150 });
    const untaxed = buildBody({ quickbooksDocumentType: 'REFUND_RECEIPT' }, TENDER);
    expect(untaxed).not.toHaveProperty('TxnTaxDetail');
  });
});
