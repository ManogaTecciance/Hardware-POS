import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';

import {
  QueryKitchenHistoryDto,
  QueryKitchenLaneCountsDto,
  QueryKitchenTicketsDto,
} from './dto/kitchen.dto';

/**
 * D174/D175 — the kitchen routes' query DTOs, run through the REAL pipe.
 *
 * The pipe below is constructed with the exact options `main.ts` gives the
 * global one (whitelist, forbid, transform, implicit conversion), and each
 * test hands it what Express hands it: a plain object with a string for a
 * param sent once and an array for one sent twice. The assertions are about
 * what reaches the controller, because that is where the contracts live:
 *
 * - D175's repeatable `stationId`/`tableId` on the history are an ARRAY at
 *   the controller whatever their arity. Implicit conversion does not wrap a
 *   scalar into a declared array type — it hands `'a'` through and `@IsArray`
 *   refuses it — so the `@Transform` is load-bearing, and the one-value case
 *   is the one this file exists to pin.
 * - D174's `stationId` on the list and counts routes is ONE plain string; two
 *   of them is a bad request, not a silent first-wins.
 * - Every field the routes read survives `whitelist`. A field with no
 *   validator decorator is silently STRIPPED under `whitelist: true`, which
 *   would reach the service as `undefined` and read as "no filter" — a bug the
 *   controller could not see. So the positive here is that the value arrives,
 *   and the negative is that an unknown param is refused rather than stripped.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function through<T>(metatype: new () => T, plain: Record<string, unknown>): Promise<T> {
  return pipe.transform(plain, { type: 'query', metatype }) as Promise<T>;
}

describe('QueryKitchenHistoryDto (D175)', () => {
  it('a param sent ONCE arrives as a one-element array', async () => {
    const dto = await through(QueryKitchenHistoryDto, { stationId: 'stn_a', tableId: 'tbl_x' });

    expect(dto.stationId).toEqual(['stn_a']);
    expect(dto.tableId).toEqual(['tbl_x']);
    // Genuinely arrays, not strings that `toEqual` happened to accept.
    expect(Array.isArray(dto.stationId)).toBe(true);
    expect(Array.isArray(dto.tableId)).toBe(true);
  });

  it('a param sent TWICE arrives as the two-element array Express built', async () => {
    const dto = await through(QueryKitchenHistoryDto, {
      stationId: ['stn_a', 'stn_b'],
      tableId: ['tbl_x', 'tbl_y'],
    });

    expect(dto.stationId).toEqual(['stn_a', 'stn_b']);
    expect(dto.tableId).toEqual(['tbl_x', 'tbl_y']);
  });

  it('absent stays absent — not an empty array the service would have to special-case', async () => {
    const dto = await through(QueryKitchenHistoryDto, {});

    expect(dto.stationId).toBeUndefined();
    expect(dto.tableId).toBeUndefined();
    // POSITIVE — the pager's defaults still arrive, so this is a DTO that was
    // built and not a transform that returned nothing.
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(25);
  });

  it('the filters and the search survive whitelisting TOGETHER, with the pager', async () => {
    const dto = await through(QueryKitchenHistoryDto, {
      page: '2',
      pageSize: '10',
      search: 'kottu',
      stationId: 'stn_a',
      tableId: ['tbl_x', 'tbl_y'],
    });

    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(10);
    expect(dto.skip).toBe(10);
    expect(dto.search).toBe('kottu');
    expect(dto.stationId).toEqual(['stn_a']);
    expect(dto.tableId).toEqual(['tbl_x', 'tbl_y']);
  });

  it('MUTATION PROOF — without the wrap, one value would be refused by @IsArray', async () => {
    /*
     * The mutant: `@Transform` gone (or returning its input unchanged). Rather
     * than a local stand-in, this drives the same pipe with the shape the
     * transform would have LEFT — the bare string — against a validator that
     * demands an array, and shows it is a 400. The wrap is what stands between
     * a lone `?stationId=a` and that response. Proven against the real source
     * too: making `asIdList` return `value` unchanged turns the first test in
     * this file red.
     */
    const { IsArray, validate } = await import('class-validator');
    class Bare {
      @IsArray() stationId?: unknown;
    }
    const bare = new Bare();
    bare.stationId = 'stn_a';
    expect((await validate(bare)).map((e) => e.property)).toEqual(['stationId']);
    // …while the shipped DTO, with the wrap, accepts the same input.
    await expect(through(QueryKitchenHistoryDto, { stationId: 'stn_a' })).resolves.toBeDefined();
  });

  it('refuses a set of more than fifty ids, and refuses an id that is not a string', async () => {
    await expect(
      through(QueryKitchenHistoryDto, {
        stationId: Array.from({ length: 51 }, (_, i) => `stn_${i}`),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Fifty exactly is still accepted, so the bound is where the DTO says.
    await expect(
      through(QueryKitchenHistoryDto, {
        stationId: Array.from({ length: 50 }, (_, i) => `stn_${i}`),
      }),
    ).resolves.toBeDefined();
    // `?stationId[x]=1` reaches the pipe as an object inside the array.
    await expect(through(QueryKitchenHistoryDto, { tableId: [{ x: '1' }] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('an unknown query param is refused, not silently dropped', async () => {
    await expect(through(QueryKitchenHistoryDto, { stationName: 'Grill' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('QueryKitchenTicketsDto and QueryKitchenLaneCountsDto (D174)', () => {
  it('the list route reads status AND stationId, both as plain strings', async () => {
    const dto = await through(QueryKitchenTicketsDto, {
      status: 'OUTSTANDING',
      stationId: 'stn_a',
    });

    expect(dto.status).toBe('OUTSTANDING');
    expect(dto.stationId).toBe('stn_a');
  });

  it('the counts route reads stationId', async () => {
    const dto = await through(QueryKitchenLaneCountsDto, { stationId: 'stn_a' });

    expect(dto.stationId).toBe('stn_a');
  });

  it('omitted, both fields are undefined — the pre-D174 read', async () => {
    const list = await through(QueryKitchenTicketsDto, {});
    const counts = await through(QueryKitchenLaneCountsDto, {});

    expect(list.status).toBeUndefined();
    expect(list.stationId).toBeUndefined();
    expect(counts.stationId).toBeUndefined();
  });

  it('NEGATIVE — a board read pinned to TWO stations is a bad request, not a first-wins', async () => {
    // The list and the counts scope to ONE station (D174); the history is the
    // read that takes a set (D175). Sending the array form here must not
    // quietly become `'stn_a,stn_b'` or the first of the two.
    await expect(
      through(QueryKitchenTicketsDto, { stationId: ['stn_a', 'stn_b'] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      through(QueryKitchenLaneCountsDto, { stationId: ['stn_a', 'stn_b'] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('an unrecognised status is NOT refused here — "no filter" is the controller’s call', async () => {
    // A stale bookmark shows the whole board rather than a 400; `parseFilter`
    // in the controller owns that mapping, so the DTO must let the string in.
    const dto = await through(QueryKitchenTicketsDto, { status: 'NOT_A_LANE' });

    expect(dto.status).toBe('NOT_A_LANE');
  });

  it('an unknown query param is refused on both routes', async () => {
    await expect(through(QueryKitchenTicketsDto, { station: 'stn_a' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(through(QueryKitchenLaneCountsDto, { stationIds: 'stn_a' })).rejects.toMatchObject(
      { status: 400 },
    );
  });
});
