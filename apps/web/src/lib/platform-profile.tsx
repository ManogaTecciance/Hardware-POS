'use client';

/**
 * The authenticated tenant's effective platform profile, for screens that must
 * present themselves differently per configuration.
 *
 * Slice 6C-B.5 scope: the product screens. This deliberately does not touch the
 * sidebar, navigation or any Restaurant surface — those belong to the frontend
 * modularisation slice, and the current Tile Shop navigation stays exactly as it
 * is. It is mounted by `app/(app)/products/layout.tsx` and nowhere else.
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
}

const UNRESOLVED: EffectiveProfileState = {
  status: 'loading',
  profile: null,
  inventoryMode: null,
};

const PlatformProfileContext = React.createContext<EffectiveProfileState>(UNRESOLVED);

export function PlatformProfileProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [state, setState] = React.useState<EffectiveProfileState>(UNRESOLVED);

  React.useEffect(() => {
    if (!session) {
      setState(UNRESOLVED);
      return;
    }
    let cancelled = false;
    setState(UNRESOLVED);
    fetchPlatformProfile(session)
      .then((profile) => {
        if (cancelled) return;
        setState({ status: 'ready', profile, inventoryMode: profile.inventoryMode });
      })
      .catch(() => {
        // No message is surfaced and no mode is guessed. A failed profile read must
        // not turn into a QuickBooks screen for a tenant that does not use it.
        if (!cancelled) setState({ status: 'error', profile: null, inventoryMode: null });
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

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
