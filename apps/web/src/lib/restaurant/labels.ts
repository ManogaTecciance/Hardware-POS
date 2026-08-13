/**
 * Human-readable labels for every restaurant enum, plus the badge tone that
 * accompanies each state.
 *
 * Centralised so a status transition or a rename never leaves half the UI
 * showing the old text.
 */

import type {
  ReservationStatus,
  KitchenPrintAttemptStatus,
  KitchenTicketStatus,
  OrderRoundStatus,
  RestaurantOrderChannel,
  RestaurantOrderItemStatus,
  RestaurantOrderStatus,
  RestaurantTableStatus,
  TableSessionStatus,
  TakeawayOrderStatus,
} from './types';
import { getActiveCurrency } from '@/lib/tenant-money';

/**
 * Tone the badge picks up. Semantic tokens the existing button uses so a
 * theme change carries through without touching every status site.
 */
export type BadgeTone =
  | 'neutral'
  | 'positive'
  | 'warning'
  | 'danger'
  | 'info'
  | 'muted';

// ── Tables ────────────────────────────────────────────────────────────────
export const TABLE_STATUS_LABELS: Record<RestaurantTableStatus, string> = {
  AVAILABLE: 'Available',
  SEATED: 'Seated',
  OCCUPIED: 'In service',
  BILLING: 'Bill requested',
  CLEANING: 'Cleaning',
  BLOCKED: 'Blocked',
  // D49: absorbed into an open table.
  RESERVED: 'Reserved',
};

export const TABLE_STATUS_TONES: Record<RestaurantTableStatus, BadgeTone> = {
  AVAILABLE: 'positive',
  SEATED: 'info',
  OCCUPIED: 'info',
  BILLING: 'warning',
  CLEANING: 'muted',
  BLOCKED: 'danger',
  RESERVED: 'info',
};

// ── Sessions ──────────────────────────────────────────────────────────────
// D47 — reservation lifecycle.
export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  BOOKED: 'Booked',
  SEATED: 'Seated',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

export const RESERVATION_STATUS_TONES: Record<ReservationStatus, BadgeTone> = {
  BOOKED: 'info',
  SEATED: 'positive',
  COMPLETED: 'muted',
  CANCELLED: 'neutral',
  NO_SHOW: 'danger',
};

export const SESSION_STATUS_LABELS: Record<TableSessionStatus, string> = {
  OPEN: 'Open',
  BILLING: 'Billing',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export const SESSION_STATUS_TONES: Record<TableSessionStatus, BadgeTone> = {
  OPEN: 'info',
  BILLING: 'warning',
  CLOSED: 'muted',
  CANCELLED: 'danger',
};

// ── Orders ────────────────────────────────────────────────────────────────
export const ORDER_STATUS_LABELS: Record<RestaurantOrderStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Sent to kitchen',
  PARTIAL: 'Partially delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const ORDER_STATUS_TONES: Record<RestaurantOrderStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  PARTIAL: 'warning',
  COMPLETED: 'positive',
  CANCELLED: 'danger',
};

// ── Rounds ────────────────────────────────────────────────────────────────
export const ROUND_STATUS_LABELS: Record<OrderRoundStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Sent',
  IN_PROGRESS: 'Preparing',
  READY: 'Ready',
  DELIVERED: 'Served',
  CANCELLED: 'Cancelled',
};

export const ROUND_STATUS_TONES: Record<OrderRoundStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  IN_PROGRESS: 'warning',
  READY: 'positive',
  DELIVERED: 'muted',
  CANCELLED: 'danger',
};

// ── Order items ───────────────────────────────────────────────────────────
export const ORDER_ITEM_STATUS_LABELS: Record<RestaurantOrderItemStatus, string> = {
  PENDING: 'Pending',
  SENT: 'Sent',
  IN_PROGRESS: 'Preparing',
  READY: 'Ready',
  DELIVERED: 'Served',
  VOIDED: 'Voided',
};

// ── Channels ──────────────────────────────────────────────────────────────
export const CHANNEL_LABELS: Record<RestaurantOrderChannel, string> = {
  DINE_IN: 'Dine-in',
  TAKEAWAY: 'Takeaway',
  ONLINE: 'Online',
};

// ── Kitchen tickets ───────────────────────────────────────────────────────
export const KITCHEN_TICKET_STATUS_LABELS: Record<KitchenTicketStatus, string> = {
  QUEUED: 'Queued',
  PRINTED: 'Printed',
  REPRINTED: 'Reprinted',
  FAILED: 'Failed',
};

export const KITCHEN_TICKET_STATUS_TONES: Record<KitchenTicketStatus, BadgeTone> = {
  QUEUED: 'info',
  PRINTED: 'positive',
  REPRINTED: 'warning',
  FAILED: 'danger',
};

export const PRINT_ATTEMPT_STATUS_LABELS: Record<KitchenPrintAttemptStatus, string> = {
  PENDING: 'Pending',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
};

// ── Takeaway ──────────────────────────────────────────────────────────────
export const TAKEAWAY_STATUS_LABELS: Record<TakeawayOrderStatus, string> = {
  PLACED: 'Placed',
  IN_KITCHEN: 'In kitchen',
  READY: 'Ready for pickup',
  HANDED_OVER: 'Handed over',
  CANCELLED: 'Cancelled',
};

export const TAKEAWAY_STATUS_TONES: Record<TakeawayOrderStatus, BadgeTone> = {
  PLACED: 'info',
  IN_KITCHEN: 'warning',
  READY: 'positive',
  HANDED_OVER: 'muted',
  CANCELLED: 'danger',
};

// ── Formatters ────────────────────────────────────────────────────────────

/**
 * Format a decimal-string money value ("12.50") as a display string.
 *
 * The backend returns strings for money; passing through as-is preserves
 * precision. `formatMoney` adds thousand separators and the currency prefix
 * without moving the decimal point.
 */
/**
 * Money for the restaurant surface. The default was the literal `'LKR'`, and
 * since no call site passes a currency that default was what every tenant got.
 * It now resolves the tenant's configured currency (D54).
 */
export function formatMoney(value: string | number, currency = getActiveCurrency()): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(n)) return `${currency} 0.00`;
  return `${currency} ${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** ISO → "42 min", "1 h 12 min". Used on table cards and KOTs. */
export function formatElapsed(fromIso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const remaining = mins % 60;
  return remaining === 0 ? `${h} h` : `${h} h ${remaining} min`;
}

/** "7:30 PM" — locale-invariant so tests are stable. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
