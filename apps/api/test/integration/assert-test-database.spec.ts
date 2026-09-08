/**
 * The production-URL guard's own spec. A guard nobody tests is a guard that
 * silently stops working, so this asserts both that realistic production URLs are
 * REJECTED and that the legitimate test URL is accepted.
 *
 * Pure — no database, no Docker. Runs in the integration Jest project alongside
 * the specs it protects.
 */

import {
  MAX_PLAUSIBLE_SCRATCH_ROWS,
  UnsafeTestDatabaseError,
  assertDatabaseLooksDisposable,
  assertTestDatabaseUrl,
} from './assert-test-database';

const TEST_URL = 'postgresql://postgres:postgres@localhost:5433/hardware_pos_test?schema=public';

function attempt(nodeEnv: string | undefined, databaseUrl: string | undefined) {
  return () => assertTestDatabaseUrl({ nodeEnv, databaseUrl });
}

describe('assertTestDatabaseUrl', () => {
  describe('accepts a legitimate disposable test database', () => {
    it('accepts the documented local test URL', () => {
      expect(assertTestDatabaseUrl({ nodeEnv: 'test', databaseUrl: TEST_URL })).toBe(
        'hardware_pos_test',
      );
    });

    it('accepts 127.0.0.1 and the postgres:// scheme', () => {
      expect(
        assertTestDatabaseUrl({
          nodeEnv: 'test',
          databaseUrl: 'postgres://postgres:postgres@127.0.0.1:5433/axlo_pos_test',
        }),
      ).toBe('axlo_pos_test');
    });

    it('accepts a compose service name on the default port', () => {
      // Inside a container the test database legitimately listens on 5432.
      expect(
        assertTestDatabaseUrl({
          nodeEnv: 'test',
          databaseUrl: 'postgresql://postgres:postgres@postgres-test:5432/hardware_pos_test',
        }),
      ).toBe('hardware_pos_test');
    });
  });

  describe('rejects production-like databases', () => {
    it.each([
      [
        'an AWS RDS host',
        'postgresql://admin:s3cret@hardware-pos.abc123.eu-north-1.rds.amazonaws.com:5432/hardware_pos',
      ],
      [
        'an RDS host even when the database is named _test',
        'postgresql://admin:s3cret@hardware-pos.abc123.eu-north-1.rds.amazonaws.com:5432/hardware_pos_test',
      ],
      ['a Neon host', 'postgresql://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb'],
      ['the product domain', 'postgresql://postgres:pw@db.axlopos.com:5432/hardware_pos'],
      ['a host named production', 'postgresql://postgres:pw@production-db.internal:5432/hardware_pos'],
      ['a database named production', 'postgresql://postgres:pw@10.0.0.4:5432/hardware_pos_production'],
      ['a staging database', 'postgresql://postgres:pw@staging.internal:5432/hardware_pos_test'],
    ])('rejects %s', (_label, url) => {
      expect(attempt('test', url)).toThrow(UnsafeTestDatabaseError);
    });

    it('rejects the real production compose URL from .env.prod.example', () => {
      // Verbatim shape of DATABASE_URL in .env.prod.example.
      expect(
        attempt('test', 'postgresql://postgres:CHANGE_ME_long_random@db:5432/hardware_pos?schema=public'),
      ).toThrow(UnsafeTestDatabaseError);
    });

    it('rejects the local DEVELOPMENT database (no _test suffix)', () => {
      expect(
        attempt('test', 'postgresql://postgres:postgres@localhost:5432/hardware_pos?schema=public'),
      ).toThrow(/does not end in "_test"/);
    });

    it('rejects a _test database still pointed at the development port', () => {
      // The likeliest real mistake: someone renamed the database in a copied dev URL.
      expect(
        attempt('test', 'postgresql://postgres:postgres@localhost:5432/hardware_pos_test'),
      ).toThrow(/port 5432 is the development\/production port/);
    });

    it('rejects an unrecognised remote host', () => {
      expect(attempt('test', 'postgresql://postgres:pw@192.168.1.50:5433/hardware_pos_test')).toThrow(
        /is not a recognised local test host/,
      );
    });
  });

  describe('rejects an unsafe environment', () => {
    it('rejects NODE_ENV=production', () => {
      expect(attempt('production', TEST_URL)).toThrow(/NODE_ENV is "production"/);
    });

    it('rejects NODE_ENV=development', () => {
      expect(attempt('development', TEST_URL)).toThrow(/expected "test"/);
    });

    it('rejects an unset NODE_ENV', () => {
      expect(attempt(undefined, TEST_URL)).toThrow(/NODE_ENV is unset/);
    });

    it('rejects a missing DATABASE_URL', () => {
      expect(attempt('test', undefined)).toThrow(/DATABASE_URL is not set/);
    });

    it('rejects a non-PostgreSQL URL', () => {
      expect(attempt('test', 'mysql://root@localhost:3306/hardware_pos_test')).toThrow(
        /is not PostgreSQL/,
      );
    });

    it('rejects an unparseable URL', () => {
      expect(attempt('test', 'not-a-url')).toThrow(/not a valid URL/);
    });

    it('rejects a URL with no database name', () => {
      expect(attempt('test', 'postgresql://postgres:postgres@localhost:5433/')).toThrow(
        /has no database name/,
      );
    });
  });
});

describe('assertDatabaseLooksDisposable', () => {
  it('accepts an empty database', async () => {
    await expect(assertDatabaseLooksDisposable({ countSales: async () => 0 })).resolves.toBeUndefined();
  });

  it('accepts a database holding a handful of fixture rows', async () => {
    await expect(assertDatabaseLooksDisposable({ countSales: async () => 12 })).resolves.toBeUndefined();
  });

  it('accepts a pre-migrate database where the table does not exist', async () => {
    await expect(
      assertDatabaseLooksDisposable({
        countSales: async () => {
          throw new Error('relation "Sale" does not exist');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a database holding a real trading history', async () => {
    await expect(
      assertDatabaseLooksDisposable({ countSales: async () => MAX_PLAUSIBLE_SCRATCH_ROWS + 1 }),
    ).rejects.toThrow(/does not look disposable/);
  });
});
