/**
 * Lane layout for reservation blocks that share a table's track.
 *
 * The server only prevents two BLOCKING reservations (BOOKED/SEATED) from
 * overlapping. A cancelled, no-show or completed booking does not hold the
 * slot — that is the point of those statuses — so "17:30 cancelled, then
 * 17:30 rebooked" is a legitimate, everyday pair of rows... which the chart
 * used to draw at the exact same pixels, one covering the other.
 *
 * A booking chart handles this with lanes: blocks that overlap in time split
 * the row's height between them instead of stacking. Pure function, in the
 * D28/D31 resolver shape — the component reads a result.
 */

export interface LaneSlot {
  startAt: string;
  endAt: string;
  status: string;
}

export interface LanedReservation<T extends LaneSlot> {
  reservation: T;
  /** 0-based lane inside this block's overlap cluster. */
  lane: number;
  /** Lanes the cluster needs — 1 means the block keeps the full row height. */
  laneCount: number;
}

/** The statuses that hold the slot — kept in step with the server's list. */
const ACTIVE_STATUSES = new Set(['BOOKED', 'SEATED']);

/**
 * Overlap clusters are resolved independently: a lone lunch booking keeps its
 * full height even when two evening blocks on the same table collide. Within
 * a cluster, lanes are assigned greedily in start order; on identical starts
 * the ACTIVE booking sorts first, so the live reservation takes the top lane
 * and the cancelled history sits under it.
 */
export function assignReservationLanes<T extends LaneSlot>(rows: T[]): LanedReservation<T>[] {
  const sorted = rows
    .slice()
    .sort(
      (a, b) =>
        new Date(a.startAt).getTime() - new Date(b.startAt).getTime() ||
        Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status)),
    );

  const out: LanedReservation<T>[] = [];
  let cluster: T[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (cluster.length === 0) return;
    // Greedy lane packing: first lane whose previous block has ended.
    const laneEnds: number[] = [];
    const placed = cluster.map((r) => {
      const start = new Date(r.startAt).getTime();
      const end = new Date(r.endAt).getTime();
      let lane = laneEnds.findIndex((e) => e <= start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      return { reservation: r, lane };
    });
    for (const p of placed) out.push({ ...p, laneCount: laneEnds.length });
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const r of sorted) {
    const start = new Date(r.startAt).getTime();
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(r);
    clusterEnd = Math.max(clusterEnd, new Date(r.endAt).getTime());
  }
  flush();
  return out;
}
