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
 * `apps/api/src/modules/platform/platform.types.ts`.
 *
 * D56: the vocabulary unions come from `@hardware-pos/shared` — browser-safe
 * by design — instead of being hand-maintained copies here. The old copies
 * were guarded by a regex over this file's source text, which broke twice
 * during D55; `platform-vocabulary.spec.ts` on the API now compares the
 * shared values against the Prisma enums at runtime instead.
 */
import type { TenantCapabilities } from '@hardware-pos/shared';

import { api } from './api';
import type { Session } from './session-store';

export type {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  TenantCapabilities,
} from '@hardware-pos/shared';
import type {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
} from '@hardware-pos/shared';

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

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
  /**
   * D56 — what this tenant's users can do, resolved server-side from the
   * domain registry. Pages read these instead of comparing `businessType`;
   * they are affordances only — every route guard still applies.
   */
  capabilities: TenantCapabilities;
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
