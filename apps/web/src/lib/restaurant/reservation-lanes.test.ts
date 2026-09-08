/**
 * Lane assignment for overlapping reservation blocks.
 *
 * Pinned in pairs: overlapping rows split into distinct lanes AND
 * non-overlapping rows keep laneCount 1 — a function that put everything in
 * its own lane would pass the first half alone, one that ignored overlaps
 * the second.
 */
import { describe, expect, it } from 'vitest';

import { assignReservationLanes } from './reservation-lanes';

const at = (h: number, m = 0) => new Date(2026, 8, 10, h, m).toISOString();

function row(startH: number, endH: number, status = 'BOOKED', startM = 0, endM = 0) {
  return { startAt: at(startH, startM), endAt: at(endH, endM), status };
}

describe('assignReservationLanes', () => {
  it('leaves non-overlapping bookings at full height', () => {
    const laid = assignReservationLanes([row(12, 13), row(19, 21)]);
    expect(laid).toHaveLength(2);
    for (const l of laid) expect(l.laneCount).toBe(1);
  });

  it('splits a cancelled slot and its rebooking into two lanes, live one on top', () => {
    const cancelled = row(17, 19, 'CANCELLED', 30, 0);
    const rebooked = row(17, 19, 'BOOKED', 30, 0);
    const laid = assignReservationLanes([cancelled, rebooked]);

    expect(laid.every((l) => l.laneCount === 2)).toBe(true);
    const live = laid.find((l) => l.reservation.status === 'BOOKED')!;
    const dead = laid.find((l) => l.reservation.status === 'CANCELLED')!;
    // Identical slot: the reservation that still holds it takes the top lane.
    expect(live.lane).toBe(0);
    expect(dead.lane).toBe(1);
  });

  it('resolves clusters independently — a lone lunch is not shrunk by a busy evening', () => {
    const laid = assignReservationLanes([
      row(12, 13),
      row(19, 21, 'NO_SHOW'),
      row(19, 21, 'BOOKED'),
      row(20, 22, 'CANCELLED'),
    ]);
    const lunch = laid.find((l) => l.reservation.startAt === at(12))!;
    expect(lunch.laneCount).toBe(1);
    // The evening cluster needs three lanes: 19–21, 19–21 and 20–22 all
    // coexist at 20:00.
    const evening = laid.filter((l) => l.reservation.startAt !== at(12));
    expect(evening.every((l) => l.laneCount === 3)).toBe(true);
    expect(new Set(evening.map((l) => l.lane)).size).toBe(3);
  });

  it('reuses a lane once its previous block has ended (half-open intervals)', () => {
    // 17–18 and 18–19 touch but do not overlap: one lane serves both.
    const laid = assignReservationLanes([row(17, 18, 'COMPLETED'), row(18, 19)]);
    expect(laid.every((l) => l.laneCount === 1)).toBe(true);
  });
});
