import { isPhoneSearchable, phoneMatches, phoneSearchKey } from '@hardware-pos/shared';

/**
 * The phone-matching rule, in isolation.
 *
 * `CustomersRepository` mirrors this reduction in SQL so it can run over rows
 * it has not loaded. These specs pin the TypeScript half; the integration spec
 * `customer-phone-search.spec.ts` drives the SQL half with the same table of
 * formats, so the two cannot drift apart without something failing.
 *
 * Held in both directions throughout: a rule that matched everything would
 * satisfy the positive cases alone, so each block pairs them with numbers that
 * must NOT match.
 */

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

describe('phoneSearchKey', () => {
  it('reduces every spelling of one number to the same key', () => {
    const keys = new Set(SAME_NUMBER.map(phoneSearchKey));
    // Not asserting the key's exact value — that is an implementation detail.
    // What matters is that these all collapse to something comparable.
    expect(keys.size).toBeLessThanOrEqual(2);
    for (const key of keys) {
      expect(key.endsWith('771234567')).toBe(true);
    }
  });

  it('keeps only digits', () => {
    expect(phoneSearchKey('+94 (77) 123-4567')).toBe('94771234567');
    // Every digit counts, including one inside an extension — the reduction
    // makes no attempt to understand what part of the string means what.
    expect(phoneSearchKey('0771234567 ext 2')).toBe('7712345672');
    expect(phoneSearchKey('abc')).toBe('');
    expect(phoneSearchKey('')).toBe('');
    expect(phoneSearchKey(null)).toBe('');
    expect(phoneSearchKey(undefined)).toBe('');
  });

  it('drops leading zeros, and only leading ones', () => {
    expect(phoneSearchKey('0771234567')).toBe('771234567');
    expect(phoneSearchKey('00771234567')).toBe('771234567');
    // The negative control: an interior zero is part of the number. A rule that
    // stripped every zero would pass the case above and mangle this one.
    expect(phoneSearchKey('0701234067')).toBe('701234067');
  });
});

describe('phoneMatches — the same number, however it was written', () => {
  it.each(SAME_NUMBER)('finds a customer stored as 0771234567 when searching %s', (term) => {
    expect(phoneMatches('0771234567', term)).toBe(true);
  });

  it.each(SAME_NUMBER)('is symmetric — stored as +94 77 123 4567, searching %s', (term) => {
    // It must not matter which of the two was saved in international format.
    expect(phoneMatches('+94 77 123 4567', term)).toBe(true);
  });

  it('matches a partial number as it is being typed', () => {
    expect(phoneMatches('0771234567', '077')).toBe(true);
    expect(phoneMatches('0771234567', '77123')).toBe(true);
    // The tail alone, which is how a customer often reads their number out.
    expect(phoneMatches('0771234567', '1234567')).toBe(true);
  });
});

describe('phoneMatches — what must not match', () => {
  it('rejects a different number', () => {
    expect(phoneMatches('0771234567', '0779999999')).toBe(false);
    expect(phoneMatches('0771234567', '0711234567')).toBe(false);
  });

  it('rejects a term with no digits at all', () => {
    expect(phoneMatches('0771234567', 'Nimal')).toBe(false);
    expect(phoneMatches('0771234567', '')).toBe(false);
  });

  it('rejects when the stored value has no digits', () => {
    expect(phoneMatches('not-a-phone', '0771234567')).toBe(false);
    expect(phoneMatches(null, '0771234567')).toBe(false);
    expect(phoneMatches('', '0771234567')).toBe(false);
  });
});

describe('isPhoneSearchable', () => {
  it('accepts a term with enough digits to be worth matching', () => {
    expect(isPhoneSearchable('077')).toBe(true);
    expect(isPhoneSearchable('0771234567')).toBe(true);
    expect(isPhoneSearchable('+94 77')).toBe(true);
  });

  it('rejects a term that would match most of the book', () => {
    // A name has no digits; `07` reduces to one digit once the trunk zero goes.
    expect(isPhoneSearchable('Nimal')).toBe(false);
    expect(isPhoneSearchable('07')).toBe(false);
    expect(isPhoneSearchable('')).toBe(false);
    expect(isPhoneSearchable(null)).toBe(false);
  });
});
