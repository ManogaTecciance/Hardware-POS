import { BadRequestException } from '@nestjs/common';
import { dayInTimeZone, parseDay, safeTimeZone, zonedTimeToUtc } from '@hardware-pos/shared';

/**
 * Resolution of the user-chosen invoice date for a POS sale ("backdating").
 *
 * The POS sends a plain calendar date (`YYYY-MM-DD`) — the day the sale actually
 * happened. That day is anchored in the SHOP's timezone: not the server's, which
 * is an accident of deployment, and not the cashier's, because the invoice the
 * date ends up on is itself rendered in the shop's zone. Anchoring it anywhere
 * else would let a sale picked as "1 Aug" print as "31 Jul" on the very document
 * the date exists to state.
 *
 * The stored instant is midday in that zone rather than midnight: midday is the
 * furthest point from a date boundary, so no DST shift or offset rounding can
 * push the sale onto a neighbouring day. Only a genuine BACKDATE takes this path
 * — a sale left on today's date sends no `saleDate` at all and keeps its real
 * instant — so the conventional 12:00 appears exactly where the true time of day
 * is unknown, rather than inventing a plausible-looking one.
 *
 * Forward dating is rejected — a sale may be dated today or earlier, "today"
 * being the shop's current day.
 */

/** Lower bound, matching the sales-history filter's floor (`query-sales.dto.ts`). */
const MIN_SALE_YEAR = 1990;

/**
 * Turn the DTO's optional `saleDate` into the UTC instant stored as `completedAt`.
 *
 * @param input `YYYY-MM-DD` as read in the shop's timezone, or undefined for "now"
 * @param tz    the shop's IANA timezone
 * @param now   injected for testability; defaults to the current instant
 * @throws BadRequestException on a malformed, impossible, future or out-of-range date
 */
export function resolveSaleDate(
  input: string | undefined,
  tz: string,
  now: Date = new Date(),
): Date {
  // No date picked: the sale happened now, and `now` is already a UTC instant.
  if (!input) return now;

  const zone = safeTimeZone(tz);
  const parts = parseDay(input);
  if (!parts) {
    throw new BadRequestException('saleDate must be a valid date (YYYY-MM-DD)');
  }
  if (parts.year < MIN_SALE_YEAR) {
    throw new BadRequestException('saleDate is out of range');
  }
  // Calendar-day comparison in the shop's zone: a sale rung at 02:00 in Colombo
  // is on today's date there even though UTC is still on yesterday.
  if (input > dayInTimeZone(now, zone)) {
    throw new BadRequestException('A sale cannot be dated in the future');
  }

  return zonedTimeToUtc(parts.year, parts.month, parts.day, 12, 0, 0, zone);
}

/**
 * QuickBooks `TxnDate` wire format — a bare calendar date, no time or offset.
 * Derived in the shop's timezone so the day filed in QuickBooks is the day the
 * invoice prints.
 */
export function toQuickBooksTxnDate(date: Date, tz: string): string {
  return dayInTimeZone(date, safeTimeZone(tz));
}

/**
 * Turn the DTO's optional `paymentDueDate` into the instant stored on the sale.
 *
 * Anchored in the shop's timezone like the invoice date, and at end of day: the
 * money is due by the close of that date, so a payment taken during it is not
 * late. A fully paid sale owes nothing and must not carry a due date at all —
 * the sales list distinguishes "nothing due" from "due on some date", and a
 * placeholder would erase that difference.
 *
 * @throws BadRequestException when required and absent, supplied when not owed,
 *         malformed, or earlier than the invoice date
 */
export function resolvePaymentDueDate(
  input: string | undefined,
  opts: { leavesBalance: boolean; saleDate: Date; tz: string },
): Date | null {
  const zone = safeTimeZone(opts.tz);

  if (!opts.leavesBalance) {
    if (input) {
      throw new BadRequestException(
        'A fully paid sale has nothing outstanding, so it cannot carry a payment due date',
      );
    }
    return null;
  }

  if (!input) {
    throw new BadRequestException('A payment due date is required for a credit sale');
  }
  const parts = parseDay(input);
  if (!parts) {
    throw new BadRequestException('paymentDueDate must be a valid date (YYYY-MM-DD)');
  }

  // Compared as calendar days in the shop's zone: payment may fall due on the
  // day of the sale, but never before it.
  if (input < dayInTimeZone(opts.saleDate, zone)) {
    throw new BadRequestException('The payment due date cannot be earlier than the invoice date');
  }

  return zonedTimeToUtc(parts.year, parts.month, parts.day, 23, 59, 59, zone);
}
