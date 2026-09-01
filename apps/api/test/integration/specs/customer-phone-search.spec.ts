/**
 * `GET /customers?search=` — a phone number is found however it was written.
 *
 * Numbers are stored exactly as the operator typed them and lookup was a plain
 * substring match on that text, so one human number written two ways could not
 * find itself: a customer saved as `0771234567` was invisible to a search for
 * `+94 77 123 4567`, the format the POS placeholder itself invites. The cashier
 * saw "not found" for a customer who exists, and created a duplicate.
 *
 * ## Why this is an integration spec
 *
 * The fix reduces the STORED value to comparable digits inside Postgres —
 * `regexp_replace` for the separators, `ltrim` for the trunk zero — because
 * Prisma's filter language cannot express it. A unit test would have to mock
 * `$queryRaw` and could not tell correct SQL from broken SQL, nor catch the
 * reduction leaking across tenants. Real Postgres is the only thing that
 * answers this (D30 §4).
 *
 * `phone-search.spec.ts` pins the TypeScript half of the same rule with this
 * exact table of formats. The two implementations have to agree, so changing
 * one without the other fails here.
 */
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let shop: SeededTenant;
let other: SeededTenant;

/** The same human number, written every way the POS invites. */
const SAME_NUMBER = [
  '0771234567',
  '077 123 4567',
  '077-123-4567',
  '+94 77 123 4567',
  '+94771234567',
  '94771234567',
  '771234567',
];

interface CustomerPage {
  items: Array<{ id: string; name: string }>;
  total: number;
}

const tokenFor = (t: SeededTenant) =>
  http.tokenFor({
    userId: t.ownerId,
    tenantId: t.tenantId,
    role: 'OWNER',
    activeBranchId: t.branchId,
  });

async function search(t: SeededTenant, term: string): Promise<string[]> {
  const res = await http.request(
    'get',
    `/customers?search=${encodeURIComponent(term)}&pageSize=50`,
    { token: tokenFor(t) },
  );
  expect(res.status).toBe(200);
  const body = res.data as unknown as CustomerPage;
  return body.items.map((i) => i.name).sort();
}

async function makeCustomer(
  t: SeededTenant,
  name: string,
  fields: { mobile?: string; phone?: string },
): Promise<void> {
  await prisma.customer.create({
    data: { tenantId: t.tenantId, name, mobile: fields.mobile ?? null, phone: fields.phone ?? null },
  });
}

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
  shop = await seedTenant(prisma, {
    prefix: 'phsearch',
    name: 'Phone Search Shop',
    slug: 'phone-search-shop',
  });
  other = await seedTenant(prisma, {
    prefix: 'phother',
    name: 'Other Shop',
    slug: 'phone-other-shop',
  });
});

describe('a number stored in national format', () => {
  beforeEach(async () => {
    await makeCustomer(shop, 'Nimal Perera', { mobile: '0771234567' });
    // A different subscriber, so every positive below has something it must
    // NOT drag in — otherwise a rule that matched everything would pass.
    await makeCustomer(shop, 'Kamal Silva', { mobile: '0719999999' });
  });

  it.each(SAME_NUMBER)('is found by %s', async (term) => {
    expect(await search(shop, term)).toEqual(['Nimal Perera']);
  });

  it('is found while the number is still being typed', async () => {
    expect(await search(shop, '077')).toEqual(['Nimal Perera']);
    expect(await search(shop, '77123')).toEqual(['Nimal Perera']);
    // The tail alone, which is how a customer often reads their number out.
    expect(await search(shop, '1234567')).toEqual(['Nimal Perera']);
  });
});

describe('a number stored in international format', () => {
  beforeEach(async () => {
    // Saved the other way round. The rule has to be symmetric, or which format
    // happened to be typed first would decide whether the record is findable.
    await makeCustomer(shop, 'Nimal Perera', { mobile: '+94 77 123 4567' });
    await makeCustomer(shop, 'Kamal Silva', { mobile: '0719999999' });
  });

  it.each(SAME_NUMBER)('is found by %s', async (term) => {
    expect(await search(shop, term)).toEqual(['Nimal Perera']);
  });
});

describe('the landline field is matched the same way', () => {
  it('finds a customer by a formatted phone, not just mobile', async () => {
    await makeCustomer(shop, 'Sunil Fernando', { phone: '011 234 5678' });

    expect(await search(shop, '0112345678')).toEqual(['Sunil Fernando']);
    expect(await search(shop, '+94112345678')).toEqual(['Sunil Fernando']);
  });
});

describe('what must not match', () => {
  beforeEach(async () => {
    await makeCustomer(shop, 'Nimal Perera', { mobile: '0771234567' });
    await makeCustomer(shop, 'Kamal Silva', { mobile: '0719999999' });
  });

  it('does not return a different subscriber', async () => {
    expect(await search(shop, '0779999999')).toEqual([]);
    expect(await search(shop, '0711234567')).toEqual([]);
  });

  it('leaves text search alone', async () => {
    // A name carries no digits, so the phone comparison never runs and the
    // existing name/company/email clauses still answer.
    expect(await search(shop, 'Nimal')).toEqual(['Nimal Perera']);
    expect(await search(shop, 'Zebra')).toEqual([]);
  });

  it('keeps the existing literal substring behaviour for a short term', async () => {
    // `07` is a literal substring of both stored numbers, and the original
    // `contains` clauses still answer for it. That behaviour predates the
    // phone rule and is deliberately untouched.
    expect(await search(shop, '07')).toEqual(['Kamal Silva', 'Nimal Perera']);
  });

  it('applies a noise floor to the reduced key', async () => {
    /*
     * `+77` and `+7` are both absent from the stored text, so neither can
     * match through the literal clauses — only the reduced key can answer,
     * which is what isolates the guard.
     *
     *   `+77` -> key `77`  (two digits, at the floor)  -> matches
     *   `+7`  -> key `7`   (one digit, below it)       -> must not
     *
     * Without the pair, a floor set to zero and a floor set to two would look
     * identical.
     */
    expect(await search(shop, '+77')).toEqual(['Nimal Perera']);
    expect(await search(shop, '+7')).toEqual([]);
  });

  it('ignores a stored value that is not a number at all', async () => {
    await makeCustomer(shop, 'Junk Row', { phone: 'not-a-phone' });
    expect(await search(shop, '0771234567')).toEqual(['Nimal Perera']);
  });
});

describe('tenant isolation', () => {
  it('never reaches another tenant customer with the same number', async () => {
    await makeCustomer(shop, 'Nimal Perera', { mobile: '0771234567' });
    await makeCustomer(other, 'Someone Else', { mobile: '+94 77 123 4567' });

    expect(await search(shop, '+94771234567')).toEqual(['Nimal Perera']);
    // The positive control: the other tenant really does hold that number, so
    // the result above is isolation rather than an empty table.
    expect(await search(other, '0771234567')).toEqual(['Someone Else']);
  });
});
