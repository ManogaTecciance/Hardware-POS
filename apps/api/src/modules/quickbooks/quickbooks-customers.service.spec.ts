import { QuickBooksCustomersService } from './quickbooks-customers.service';
import * as api from './quickbooks.api';

jest.mock('./quickbooks.api', () => ({
  queryCustomerByName: jest.fn(),
  createCustomer: jest.fn(),
}));

const queryByName = api.queryCustomerByName as jest.MockedFunction<typeof api.queryCustomerByName>;
const create = api.createCustomer as jest.MockedFunction<typeof api.createCustomer>;

const PARAMS = { apiBase: 'https://qbo.test', realmId: 'r1', accessToken: 't' };

/** Minimal Prisma stand-in over a single in-memory customer row. */
function fakePrisma(customer: Record<string, unknown> | null) {
  const row = customer ? { ...customer } : null;
  return {
    row,
    updates: [] as Record<string, unknown>[],
    customer: {
      findFirst: jest.fn(async () => row),
      // Write-once claim: only succeeds while quickbooksCustomerId is still null,
      // mirroring the compare-and-set the service relies on.
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!row || row.quickbooksCustomerId) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cus_1',
    tenantId: 't1',
    name: 'Anura Hardware',
    quickbooksCustomerId: null,
    company: null,
    email: null,
    phone: null,
    mobile: null,
    fax: null,
    website: null,
    resaleNumber: null,
    street: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    ...overrides,
  };
}

/** Only the Prisma dep matters here; the QBO plumbing is exercised via pushCustomer elsewhere. */
function svc(prisma: ReturnType<typeof fakePrisma>) {
  return new QuickBooksCustomersService(
    prisma as never,
    null as never,
    null as never,
    null as never,
  );
}

function bareService() {
  return new QuickBooksCustomersService(null as never, null as never, null as never, null as never);
}

/**
 * Reach a private through a cast, the way quickbooks-sales-sync.service.spec.ts
 * already does — rather than widening the service's public surface for tests.
 */
function priv<T>(svc: QuickBooksCustomersService, name: string): T {
  return (svc as unknown as Record<string, T>)[name];
}

type InputFn = (displayName: string, customer: unknown) => Record<string, unknown>;
type DupFn = (err: unknown) => boolean;

function buildInput(displayName: string, customer: unknown): Record<string, unknown> {
  const svc = bareService();
  return priv<InputFn>(svc, 'toCustomerInput').call(svc, displayName, customer);
}

function isDup(err: unknown): boolean {
  const svc = bareService();
  return priv<DupFn>(svc, 'isDuplicateName').call(svc, err);
}

beforeEach(() => {
  queryByName.mockReset();
  create.mockReset();
});

describe('resolveCustomerRef', () => {
  it('returns null for a walk-in sale with no customer', async () => {
    const prisma = fakePrisma(null);
    expect(await svc(prisma).resolveCustomerRef('t1', null, PARAMS)).toBeNull();
    expect(queryByName).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('uses the id already stored on the customer, without calling QuickBooks', async () => {
    // The regression this whole service exists for: the linkage lives on
    // Customer.quickbooksCustomerId, not in the never-written mapping table.
    const prisma = fakePrisma(makeCustomer({ quickbooksCustomerId: '58' }));
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).toEqual({ value: '58' });
    expect(queryByName).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('adopts an existing QuickBooks customer of the same name rather than duplicating', async () => {
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue({ Id: '77', DisplayName: 'Anura Hardware' } as never);
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).toEqual({ value: '77' });
    expect(create).not.toHaveBeenCalled();
    expect(prisma.row?.quickbooksCustomerId).toBe('77');
  });

  it('creates the customer when QuickBooks has no match, and stores the id', async () => {
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue(null);
    create.mockResolvedValue({ Id: '91', DisplayName: 'Anura Hardware' } as never);
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).toEqual({ value: '91' });
    expect(prisma.row?.quickbooksCustomerId).toBe('91');
    expect(prisma.row?.syncStatus).toBe('SYNCED');
  });

  it('does not create a second customer when the sync is retried', async () => {
    // The queue retries failed sales; the id persisted on the first attempt must
    // short-circuit the second, or every retry would add a customer.
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue(null);
    create.mockResolvedValue({ Id: '91', DisplayName: 'Anura Hardware' } as never);
    const service = svc(prisma);
    await service.resolveCustomerRef('t1', 'cus_1', PARAMS);
    await service.resolveCustomerRef('t1', 'cus_1', PARAMS);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('adopts the existing record when a concurrent write wins the name race', async () => {
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValueOnce(null); // nothing there when we looked
    create.mockRejectedValue(
      new Error(
        'QuickBooks customer create failed (400): {"code":"6240","Message":"Duplicate Name Exists Error"}',
      ),
    );
    queryByName.mockResolvedValueOnce({ Id: '77', DisplayName: 'Anura Hardware' } as never);
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).toEqual({ value: '77' });
    expect(prisma.row?.quickbooksCustomerId).toBe('77');
  });

  it('adopts the id a concurrent run already claimed rather than overwriting it', async () => {
    // Two sales for the same new customer can sync at once; the loser must take
    // the winner's id, not stamp its own over the top.
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue(null);
    create.mockResolvedValue({ Id: '91', DisplayName: 'Anura Hardware' } as never);
    prisma.customer.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    prisma.customer.findFirst
      .mockResolvedValueOnce(makeCustomer() as never)
      .mockResolvedValueOnce({ quickbooksCustomerId: '55' } as never);
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).toEqual({ value: '55' });
  });

  it('reports a name taken by something that is not an active customer', async () => {
    // A vendor of the same name also trips 6240, and re-querying customers finds
    // nothing — that is unrecoverable and must say so, not retry forever.
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue(null);
    create.mockRejectedValue(new Error('failed (400): {"code":"6240"}'));
    await expect(svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).rejects.toThrow(
      /vendor or inactive record/i,
    );
  });

  it('rethrows a create failure that is not a name clash', async () => {
    const prisma = fakePrisma(makeCustomer());
    queryByName.mockResolvedValue(null);
    create.mockRejectedValue(new Error('QuickBooks customer create failed (401): unauthorized'));
    await expect(svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).rejects.toThrow(/401/);
  });

  it('refuses to create a nameless customer rather than writing a blank one', async () => {
    const prisma = fakePrisma(makeCustomer({ name: '   ' }));
    await expect(svc(prisma).resolveCustomerRef('t1', 'cus_1', PARAMS)).rejects.toThrow(/no name/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the customer belongs to another tenant', async () => {
    const prisma = fakePrisma(null); // findFirst is tenant-scoped and finds nothing
    expect(await svc(prisma).resolveCustomerRef('t1', 'cus_other', PARAMS)).toBeNull();
  });
});

describe('duplicate-name detection', () => {
  it.each([
    'QuickBooks customer create failed (400): {"code":"6240"}',
    'Duplicate Name Exists Error',
    'duplicate name exists',
  ])('recognises %s', (message) => {
    expect(isDup(new Error(message))).toBe(true);
  });

  it.each(['unauthorized', 'ValidationFault code 6560'])('does not misread %s', (message) => {
    expect(isDup(new Error(message))).toBe(false);
  });
});

describe('the QuickBooks create body', () => {
  it('sends only the display name for a bare customer', () => {
    expect(buildInput('Anura Hardware', makeCustomer())).toEqual({
      DisplayName: 'Anura Hardware',
    });
  });

  it('maps the contact fields QuickBooks understands', () => {
    const body = buildInput(
      'Anura Hardware',
      makeCustomer({
        company: 'Anura Pvt Ltd',
        email: 'a@example.lk',
        phone: '+94 11 234 5678',
        mobile: '+94 77 123 4567',
        website: 'https://anura.lk',
        resaleNumber: 'R-99',
      }),
    );
    expect(body).toMatchObject({
      CompanyName: 'Anura Pvt Ltd',
      PrimaryEmailAddr: { Address: 'a@example.lk' },
      PrimaryPhone: { FreeFormNumber: '+94 11 234 5678' },
      Mobile: { FreeFormNumber: '+94 77 123 4567' },
      WebAddr: { URI: 'https://anura.lk' },
      ResaleNum: 'R-99',
    });
  });

  it('includes an address only when there is one', () => {
    const empty = buildInput('X', makeCustomer());
    expect(empty.BillAddr).toBeUndefined();

    const withAddr = buildInput(
      'X',
      makeCustomer({ street: '12 Galle Rd', city: 'Colombo', country: 'Sri Lanka' }),
    );
    expect(withAddr.BillAddr).toEqual({
      Line1: '12 Galle Rd',
      City: 'Colombo',
      Country: 'Sri Lanka',
    });
  });

  it('sends the fax number, which the inbound pull also maps', () => {
    expect(buildInput('X', makeCustomer({ fax: '+94 11 999 0000' }))).toMatchObject({
      Fax: { FreeFormNumber: '+94 11 999 0000' },
    });
  });

  it('drops whitespace-only fields instead of sending blanks', () => {
    const body = buildInput('X', makeCustomer({ email: '   ', city: '  ' }));
    expect(body.PrimaryEmailAddr).toBeUndefined();
    expect(body.BillAddr).toBeUndefined();
  });
});
