/**
 * Supplier Management — shared formatting, validation, and alert derivation.
 * Pure functions only (unit-tested), so no duplicated formatting or validation
 * logic leaks into presentational components.
 */

import { formatMoney } from '@/lib/utils';

import type {
  Supplier,
  SupplierContactInput,
  SupplierInput,
} from './types';

// ── Formatting ───────────────────────────────────────────────────────────────

/** Initials for a logo fallback, e.g. "Axlo Hardware" → "AH". */
export function supplierInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '—';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/** Money, or a labelled placeholder when the value is unavailable/unsynced. */
export function formatBalance(value: number | null, unavailable = 'Not synced'): string {
  return value == null ? unavailable : formatMoney(value);
}

/** `12 Mar 2026` — stable, locale-independent, SSR-safe. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Human file size, e.g. `1.2 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** "MMM YY" label for a `YYYY-MM` chart month. */
export function formatChartMonth(month: string): string {
  const [y, m] = month.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m) - 1;
  return `${months[idx] ?? m} ${(y ?? '').slice(2)}`;
}

/**
 * Suggest a supplier code from the name, e.g. "Axlo Hardware" → "AXL-HAR".
 * The code is editable and validated for uniqueness before saving.
 */
export function suggestSupplierCode(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const w0 = words[0];
  if (!w0) return '';
  const w1 = words[1];
  if (!w1) return w0.slice(0, 6);
  return `${w0.slice(0, 3)}-${w1.slice(0, 3)}`;
}

// ── Validation ───────────────────────────────────────────────────────────────

export type SupplierFieldErrors = Partial<
  Record<'name' | 'code' | 'contact' | 'email' | 'creditLimit', string>
>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a supplier draft with plain-language messages. Returns a map keyed by
 * field so the form can associate each message with its input and focus the
 * first invalid one. `existingCodes` are lower-cased codes already in use
 * (excluding the record being edited).
 */
export function validateSupplierDraft(
  input: SupplierInput,
  existingCodes: string[] = [],
): SupplierFieldErrors {
  const errors: SupplierFieldErrors = {};

  if (!input.name.trim()) {
    errors.name = 'Enter the supplier’s name.';
  }

  const code = (input.code ?? '').trim();
  if (code && existingCodes.includes(code.toLowerCase())) {
    errors.code = 'A supplier is already using this supplier code.';
  }

  const hasPhone = !!input.phone?.trim();
  const hasEmail = !!input.email?.trim();
  if (!hasPhone && !hasEmail) {
    errors.contact = 'Enter at least one phone number or email address.';
  }

  if (hasEmail && !EMAIL_RE.test(input.email!.trim())) {
    errors.email = 'Enter a valid email address.';
  }

  if (input.creditLimit != null && (Number.isNaN(input.creditLimit) || input.creditLimit < 0)) {
    errors.creditLimit = 'Enter a credit limit of zero or more.';
  }

  return errors;
}

export type ContactFieldErrors = Partial<
  Record<'fullName' | 'contact' | 'email', string>
>;

export function validateContactDraft(input: SupplierContactInput): ContactFieldErrors {
  const errors: ContactFieldErrors = {};
  if (!input.fullName.trim()) {
    errors.fullName = 'Enter the contact’s name.';
  }
  const hasPhone = !!input.phone?.trim() || !!input.whatsapp?.trim();
  const hasEmail = !!input.email?.trim();
  if (!hasPhone && !hasEmail) {
    errors.contact = 'Enter at least one phone number or email address.';
  }
  if (hasEmail && !EMAIL_RE.test(input.email!.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  return errors;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'danger';

export interface SupplierAlert {
  id: string;
  severity: AlertSeverity;
  message: string;
  /** Label for the resolution action; every alert must offer a path forward. */
  actionLabel: string;
  /** Which resolution the profile should route to. */
  action:
    | 'add-contact'
    | 'map-quickbooks'
    | 'retry-sync'
    | 'edit'
    | 'reactivate'
    | 'view-financials'
    | 'link-products'
    | 'review-bank';
}

/**
 * Derive contextual, actionable profile alerts. Each alert carries a severity,
 * a plain explanation, and a direct resolution — never a dead-end warning.
 */
export function deriveSupplierAlerts(
  supplier: Supplier,
  ctx: { hasPrimaryContact: boolean; linkedProductCount: number; bankRecentlyChanged?: boolean },
): SupplierAlert[] {
  const alerts: SupplierAlert[] = [];

  if (supplier.status === 'BLOCKED') {
    alerts.push({
      id: 'blocked',
      severity: 'danger',
      message: supplier.blockedReason
        ? `This supplier is blocked: ${supplier.blockedReason}`
        : 'This supplier is blocked and unavailable for new purchasing.',
      actionLabel: 'Reactivate',
      action: 'reactivate',
    });
  } else if (supplier.status === 'INACTIVE') {
    alerts.push({
      id: 'inactive',
      severity: 'warning',
      message: 'This supplier is inactive and hidden from new purchasing.',
      actionLabel: 'Reactivate',
      action: 'reactivate',
    });
  }

  if (!ctx.hasPrimaryContact) {
    alerts.push({
      id: 'no-primary-contact',
      severity: 'warning',
      message: 'This supplier has no primary contact.',
      actionLabel: 'Add contact',
      action: 'add-contact',
    });
  }

  if (supplier.quickbooks.status === 'NOT_CONNECTED') {
    alerts.push({
      id: 'qb-unmapped',
      severity: 'info',
      message: 'This supplier is not connected to a QuickBooks vendor.',
      actionLabel: 'Map vendor',
      action: 'map-quickbooks',
    });
  } else if (supplier.quickbooks.status === 'ATTENTION') {
    alerts.push({
      id: 'qb-attention',
      severity: 'danger',
      message: 'QuickBooks synchronization needs attention.',
      actionLabel: 'View mapping',
      action: 'map-quickbooks',
    });
  }

  if (!supplier.vatNumber && !supplier.registrationNumber) {
    alerts.push({
      id: 'tax-missing',
      severity: 'info',
      message: 'Tax details (VAT/TIN or registration number) are missing.',
      actionLabel: 'Add details',
      action: 'edit',
    });
  }

  if (
    supplier.financials.available &&
    supplier.financials.overdueBalance != null &&
    supplier.financials.overdueBalance > 0
  ) {
    alerts.push({
      id: 'overdue',
      severity: 'danger',
      message: `This supplier has an overdue balance of ${formatMoney(supplier.financials.overdueBalance)}.`,
      actionLabel: 'View financials',
      action: 'view-financials',
    });
  }

  if (ctx.linkedProductCount === 0) {
    alerts.push({
      id: 'no-products',
      severity: 'info',
      message: 'No products are linked to this supplier yet.',
      actionLabel: 'Link products',
      action: 'link-products',
    });
  }

  if (ctx.bankRecentlyChanged) {
    alerts.push({
      id: 'bank-changed',
      severity: 'warning',
      message: 'Bank details were changed recently. Please confirm they are correct.',
      actionLabel: 'Review bank details',
      action: 'review-bank',
    });
  }

  return alerts;
}
