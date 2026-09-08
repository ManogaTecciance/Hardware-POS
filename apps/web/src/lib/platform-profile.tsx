'use client';

/**
 * The authenticated tenant's effective platform profile, for screens that must
 * present themselves differently per configuration.
 *
 * Introduced in Slice 6C-B.5 scoped to the product screens; promoted in Slice 8 to
 * the authenticated app shell, which is where navigation, the workspace shell and
 * the product screens all read it from. Mounted exactly once, by
 * `app/(app)/layout.tsx`.
 *
 * ## Three states, and why the third is not "assume QuickBooks"
 *
 * `loading` and `error` both resolve to `inventoryMode: null`, which every consumer
 * treats as "offer no external action". The tempting alternative — default to the
 * legacy QuickBooks configuration on the client while the request is in flight — is
 * precisely the bug this hook exists to prevent: a LOCAL tenant would see
 * "Sync to QuickBooks" flash on every page load, and would keep seeing it forever
 * if the profile request ever failed.
 *
 * The server is the authority regardless. This only decides what is drawn.
 */

import * as React from 'react';

import { forgetCurrency, primeTenantCurrency } from '@/lib/tenant-money';

import { useAuth } from './auth';
import { fetchPlatformProfile, type EffectiveBusinessProfile, type InventoryMode } from './platform-api';

export type ProfileStatus = 'loading' | 'ready' | 'error';

export interface EffectiveProfileState {
  status: ProfileStatus;
  profile: EffectiveBusinessProfile | null;
  /**
   * The authoritative inventory mode, or `null` when it is not known.
   *
   * This is the single value the product presentation resolver may route on.
   */
  inventoryMode: InventoryMode | null;
  /**
   * Re-read the profile from the server.
   *
   * Called after a profile update so the navigation and the product screens reflect
   * the change without a page reload. It refetches rather than patching local state:
   * the server owns module resolution, and a client-side merge would be a second,
   * divergent implementation of it.
   */
  refresh: () => void;
}

const UNRESOLVED: EffectiveProfileState = {
  status: 'loading',
  profile: null,
  inventoryMode: null,
  refresh: () => undefined,
};

const PlatformProfileContext = React.createContext<EffectiveProfileState>(UNRESOLVED);

export function PlatformProfileProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [state, setState] = React.useState<EffectiveProfileState>(UNRESOLVED);
  const [reloadKey, setReloadKey] = React.useState(0);

  const refresh = React.useCallback(() => setReloadKey((k) => k + 1), []);

  /*
   * D54 — resolve the tenant's display currency once for the whole shell, the
   * same way this provider resolves the profile. Money is formatted in dozens
   * of synchronous render paths that cannot each await the settings API, so
   * the code is cached and read from there. Signing out forgets it: the next
   * user on this device may belong to a tenant trading in another currency.
   */
  React.useEffect(() => {
    if (!session) {
      forgetCurrency();
      return;
    }
    void primeTenantCurrency(session);
  }, [session]);

  React.useEffect(() => {
    // Signing out must clear the profile, not merely stop using it: the next user
    // to sign in on this device could belong to a different tenant, and a stale
    // `enabledModules` would render their predecessor's navigation for a moment.
    if (!session) {
      setState({ ...UNRESOLVED, refresh });
      return;
    }
    let cancelled = false;
    setState({ ...UNRESOLVED, refresh });
    fetchPlatformProfile(session)
      .then((profile) => {
        if (cancelled) return;
        setState({ status: 'ready', profile, inventoryMode: profile.inventoryMode, refresh });
      })
      .catch(() => {
        // No message is surfaced and no mode is guessed. A failed profile read must
        // not turn into a QuickBooks screen for a tenant that does not use it, nor
        // into retail navigation for a restaurant.
        if (!cancelled) {
          setState({ status: 'error', profile: null, inventoryMode: null, refresh });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadKey, refresh]);

  return (
    <PlatformProfileContext.Provider value={state}>{children}</PlatformProfileContext.Provider>
  );
}

/**
 * The effective profile for the signed-in tenant.
 *
 * Returns the unresolved state outside a provider rather than throwing, so a
 * component rendered without one fails safe instead of failing loudly into a
 * QuickBooks default.
 */
export function useEffectiveProfile(): EffectiveProfileState {
  return React.useContext(PlatformProfileContext);
}
