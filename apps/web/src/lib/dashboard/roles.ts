import type { UserRole } from '@/lib/permissions';

/** Which dashboard composition a role sees. Backend permissions remain the
 *  security source of truth — this only shapes the UI. */
export type DashboardVariant = 'admin' | 'cashier';

/**
 * Central role → dashboard resolver. Keep this the ONLY place that maps roles to
 * a dashboard variant so no component hard-codes role-name checks.
 *
 * - OWNER / ADMIN / SALESPERSON / MANAGER / ACCOUNTANT → the analytical Admin dashboard
 * - CASHIER → the operational Cashier dashboard
 *
 * Pure and side-effect free so it is trivially unit-testable.
 */
export function resolveDashboardVariant(role: UserRole): DashboardVariant {
  return role === 'CASHIER' ? 'cashier' : 'admin';
}

/**
 * Time-of-day greeting. Pure (hour is injected) so it is trivially testable and
 * free of SSR/hydration drift — callers pass `new Date().getHours()` on the
 * client. 5–11 morning, 12–16 afternoon, 17–21 evening, else night.
 */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good evening';
}

/** First name for a friendly greeting; falls back to the whole string. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}
