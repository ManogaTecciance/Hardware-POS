import { QuickBooksRefundTenderService } from './quickbooks-refund-tender.service';
import type { QboAccount, QboPaymentMethod } from './quickbooks.api';

jest.mock('./quickbooks.api', () => ({
  queryAccounts: jest.fn(),
  queryPaymentMethods: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const api = require('./quickbooks.api') as {
  queryAccounts: jest.Mock;
  queryPaymentMethods: jest.Mock;
};

const PARAMS = { apiBase: 'https://qbo.test', realmId: '1', accessToken: 't' };
const CONTEXT = { returnId: 'r1', returnNumber: 'R-000002' };

const ACCOUNTS: QboAccount[] = [
  { Id: '10', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds' },
  { Id: '20', Name: 'Cash on hand', AccountType: 'Bank', AccountSubType: 'CashOnHand' },
  { Id: '30', Name: 'Commercial Bank Current', AccountType: 'Bank', AccountSubType: 'Checking' },
  { Id: '40', Name: 'Sales of Product Income', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' },
];

const METHODS: QboPaymentMethod[] = [
  { Id: '1', Name: 'Cash', Type: 'NON_CREDIT_CARD' },
  { Id: '2', Name: 'Visa', Type: 'CREDIT_CARD' },
  { Id: '3', Name: 'Cheque', Type: 'NON_CREDIT_CARD' },
];

/** A settings stand-in; `returns` overrides the two fields under test. */
function settingsStub(returns: Record<string, unknown> = {}) {
  return {
    getSettings: () => ({
      returns: {
        quickbooksRefundReceiptDepositAccountRef: null,
        quickbooksRefundDepositAccountRefs: {},
        ...returns,
      },
    }),
  } as never;
}

const syncLogCreate = jest.fn();
const prismaStub = { syncLog: { create: syncLogCreate } } as never;

function service(returns: Record<string, unknown> = {}) {
  return new QuickBooksRefundTenderService(prismaStub, settingsStub(returns));
}

beforeEach(() => {
  jest.clearAllMocks();
  syncLogCreate.mockResolvedValue({});
  api.queryAccounts.mockResolvedValue(ACCOUNTS);
  api.queryPaymentMethods.mockResolvedValue(METHODS);
});

describe('deposit account — configuration wins', () => {
  it('uses the per-tender override for that tender', async () => {
    const svc = service({ quickbooksRefundDepositAccountRefs: { CASH: '20', CARD: '30' } });
    const cash = await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(cash.depositToAccountRef).toEqual({ value: '20', name: 'Cash on hand' });
    expect(cash.inferred).toBe(false);
  });

  it('falls back to the flat setting for a tender with no override', async () => {
    const svc = service({
      quickbooksRefundReceiptDepositAccountRef: '10',
      quickbooksRefundDepositAccountRefs: { CASH: '20' },
    });
    const card = await svc.resolve('t1', 'CARD', PARAMS, CONTEXT);
    expect(card.depositToAccountRef.value).toBe('10');
  });

  it('sends a configured id QuickBooks did not return, rather than refusing the sync', async () => {
    // The account query is capped at 1000 rows, so an unseen id can still be real.
    const svc = service({ quickbooksRefundReceiptDepositAccountRef: '999' });
    const res = await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.depositToAccountRef).toEqual({ value: '999' });
  });

  it('ignores a whitespace-only setting and infers instead', async () => {
    const svc = service({ quickbooksRefundReceiptDepositAccountRef: '   ' });
    const res = await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.inferred).toBe(true);
  });

  it('writes no sync-log note when the account was configured', async () => {
    const svc = service({ quickbooksRefundReceiptDepositAccountRef: '10' });
    await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(syncLogCreate).not.toHaveBeenCalled();
  });
});

describe('deposit account — inference by tender', () => {
  it('refunds cash out of the drawer', async () => {
    const res = await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.depositToAccountRef).toEqual({ value: '20', name: 'Cash on hand' });
    expect(res.inferred).toBe(true);
  });

  it('reverses a card refund through undeposited funds', async () => {
    const res = await service().resolve('t1', 'CARD', PARAMS, CONTEXT);
    expect(res.depositToAccountRef.value).toBe('10');
  });

  it('sends a bank transfer out of the current account', async () => {
    const res = await service().resolve('t1', 'BANK_TRANSFER', PARAMS, CONTEXT);
    expect(res.depositToAccountRef.value).toBe('30');
  });

  it('falls back to a bare Bank account when no subtype matches', async () => {
    api.queryAccounts.mockResolvedValue([
      { Id: '55', Name: 'Sampath Bank', AccountType: 'Bank' },
      ...ACCOUNTS.filter((a) => a.AccountType === 'Income'),
    ]);
    const res = await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.depositToAccountRef).toEqual({ value: '55', name: 'Sampath Bank' });
  });

  it('handles a return with no recorded tender', async () => {
    const res = await service().resolve('t1', null, PARAMS, CONTEXT);
    expect(res.depositToAccountRef.value).toBe('10');
    expect(res.paymentMethodRef).toBeNull();
  });

  it('fails with an actionable message when the company has no candidate account', async () => {
    api.queryAccounts.mockResolvedValue(ACCOUNTS.filter((a) => a.AccountType === 'Income'));
    await expect(service().resolve('t1', 'CASH', PARAMS, CONTEXT)).rejects.toThrow(
      /no Bank, Cash on Hand or Undeposited Funds account/i,
    );
  });

  it('records the inferred account in the sync log', async () => {
    await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(syncLogCreate).toHaveBeenCalledTimes(1);
    const { data } = syncLogCreate.mock.calls[0][0];
    expect(data.entityId).toBe('r1');
    expect(data.message).toContain('Cash on hand (20)');
    expect(data.message).toContain('R-000002');
  });

  it('still refunds when the audit row cannot be written', async () => {
    syncLogCreate.mockRejectedValueOnce(new Error('db down'));
    const res = await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.depositToAccountRef.value).toBe('20');
  });
});

describe('payment method', () => {
  it('matches the tender by name', async () => {
    const res = await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.paymentMethodRef).toEqual({ value: '1', name: 'Cash' });
  });

  it('matches a cheque spelled either way', async () => {
    const res = await service().resolve('t1', 'CHECK', PARAMS, CONTEXT);
    expect(res.paymentMethodRef?.value).toBe('3');
  });

  it('falls back to QuickBooks own CREDIT_CARD flag for a card refund', async () => {
    const res = await service().resolve('t1', 'CARD', PARAMS, CONTEXT);
    expect(res.paymentMethodRef).toEqual({ value: '2', name: 'Visa' });
  });

  it('omits the tender when nothing matches, rather than guessing', async () => {
    const res = await service().resolve('t1', 'QR_PAYMENT', PARAMS, CONTEXT);
    expect(res.paymentMethodRef).toBeNull();
  });

  it('never names a tender for store credit', async () => {
    const res = await service().resolve('t1', 'STORE_CREDIT', PARAMS, CONTEXT);
    expect(res.paymentMethodRef).toBeNull();
  });

  it('still resolves the account when the payment-method query fails', async () => {
    api.queryPaymentMethods.mockRejectedValue(new Error('403 Forbidden'));
    const res = await service().resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(res.depositToAccountRef.value).toBe('20');
    expect(res.paymentMethodRef).toBeNull();
  });
});

describe('lookup caching', () => {
  it('queries QuickBooks once per tenant, not once per refund', async () => {
    const svc = service();
    await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    await svc.resolve('t1', 'CARD', PARAMS, CONTEXT);
    expect(api.queryAccounts).toHaveBeenCalledTimes(1);
  });

  it('keeps one tenant’s chart of accounts out of another’s', async () => {
    const svc = service();
    await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    await svc.resolve('t2', 'CASH', PARAMS, CONTEXT);
    expect(api.queryAccounts).toHaveBeenCalledTimes(2);
  });

  it('re-queries after the cache is dropped', async () => {
    const svc = service();
    await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    svc.forget('t1');
    await svc.resolve('t1', 'CASH', PARAMS, CONTEXT);
    expect(api.queryAccounts).toHaveBeenCalledTimes(2);
  });
});
