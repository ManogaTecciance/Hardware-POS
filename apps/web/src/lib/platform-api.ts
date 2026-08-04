/**
 * Platform profile API client — the tenant's business type, inventory/accounting
 * mode, and enabled modules.
 *
 * Slice 4 scope is deliberately just this typed client. Nothing imports it yet:
 * the sidebar, navigation, and any Restaurant settings screen belong to Slice 8's
 * frontend modularisation, and the current Tile Shop navigation must stay exactly
 * as it is until then.
 *
 * Mirrors the backend `EffectiveBusinessProfile` / `ModuleState` shapes from
 * `apps/api/src/modules/platform/platform.types.ts`. The union members are
 * duplicated here rather than imported from `@hardware-pos/database` because that
 * package pulls in the Prisma client, which must not reach the browser bundle.
 */
import { api } from './api';
import type { Session } from './session-store';

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export type BusinessType =
  | 'TILE_SHOP'
  | 'HARDWARE'
  | 'RETAIL'
  | 'RESTAURANT'
  | 'CAFE'
  | 'BAKERY'
  | 'GENERAL';

export type InventoryMode = 'LOCAL' | 'QUICKBOOKS' | 'EXTERNAL' | 'DISABLED';

export type AccountingProviderKind = 'NONE' | 'QUICKBOOKS' | 'FUTURE_EXTERNAL';

/**
 * Switchable feature modules. `PAYMENTS` is intentionally absent — taking payment
 * is core to every business profile and is never switchable off.
 */
export type ModuleKey =
  | 'RETAIL_POS'
  | 'INVENTORY'
  | 'CUSTOMERS'
  | 'QUOTATIONS'
  | 'RETURNS'
  | 'EXCHANGES'
  | 'SUPPLIERS'
  | 'REPORTING'
  | 'USERS'
  | 'BRANCHES'
  | 'SETTINGS'
  | 'BRANDING'
  | 'QUICKBOOKS'
  | 'MENU_MANAGEMENT'
  | 'DINING'
  | 'TABLE_MANAGEMENT'
  | 'TAKEAWAY'
  | 'KITCHEN'
  | 'KITCHEN_DISPLAY'
  | 'ONLINE_ORDERS'
  | 'DELIVERY_INTEGRATIONS'
  | 'RESERVATIONS';

/**
 * `LEGACY_DEFAULT` means the tenant has no stored profile and is running the
 * pre-Slice-4 Tile Shop configuration. That is a supported state, not an
 * incomplete setup — the UI must not prompt the user to fix it.
 */
export type ProfileSource = 'EXPLICIT' | 'LEGACY_DEFAULT';

export interface EffectiveBusinessProfile {
  source: ProfileSource;
  businessType: BusinessType;
  inventoryMode: InventoryMode;
  accountingProvider: AccountingProviderKind;
  enabledModules: ModuleKey[];
  /** Optimistic-concurrency token, or null for a legacy default. */
  version: number | null;
  updatedAt: string | null;
}

export interface ModuleState {
  moduleKey: ModuleKey;
  isEnabled: boolean;
  /** `false` when the value comes from the business-type default, not a stored row. */
  isExplicit: boolean;
}

/**
 * A partial profile update.
 *
 * There is no `tenantId`: the API derives the tenant from the session, and sending
 * one is rejected with a 400 rather than silently ignored. Omitting
 * `enabledModules` leaves module configuration untouched; sending it replaces the
 * configuration wholesale.
 */
export interface UpdateBusinessProfileInput {
  businessType?: BusinessType;
  inventoryMode?: InventoryMode;
  accountingProvider?: AccountingProviderKind;
  enabledModules?: ModuleKey[];
}

/** The effective profile for the signed-in tenant. Readable by every role. */
export function fetchPlatformProfile(session: Session): Promise<EffectiveBusinessProfile> {
  return api.get<EffectiveBusinessProfile>('/platform/profile', auth(session));
}

/** Per-module enablement, including modules explicitly switched off. */
export function fetchPlatformModules(session: Session): Promise<ModuleState[]> {
  return api.get<ModuleState[]>('/platform/modules', auth(session));
}

/** Create or update the tenant's explicit profile. Owner/Admin only (403 otherwise). */
export function updatePlatformProfile(
  session: Session,
  input: UpdateBusinessProfileInput,
): Promise<EffectiveBusinessProfile> {
  return api.patch<EffectiveBusinessProfile>('/platform/profile', input, auth(session));
}

/** Is a module enabled in an already-fetched profile? */
export function isModuleEnabled(
  profile: EffectiveBusinessProfile,
  moduleKey: ModuleKey,
): boolean {
  return profile.enabledModules.includes(moduleKey);
}
