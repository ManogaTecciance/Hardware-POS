'use client';

import * as React from 'react';

/**
 * Sidebar UI state. The desktop rail can be collapsed to an icon-only strip and
 * that preference persists to localStorage, so it survives reloads. The mobile
 * drawer (`mobileOpen`) is ephemeral navigation state and is deliberately never
 * persisted. Mirrors the hydration pattern in `return-draft.tsx`: read storage
 * in a mount effect and flip a `hydrated` flag so SSR and the first client
 * render agree (avoids a hydration mismatch on the rail width).
 */
const STORAGE_KEY = 'hpos.sidebar.collapsed';

interface SidebarValue {
  /** Desktop rail is collapsed to icons only. Persisted. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Mobile off-canvas drawer is open. Ephemeral. */
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;
  /** True once localStorage has been read on the client. */
  hydrated: boolean;
}

const SidebarContext = React.createContext<SidebarValue | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw != null) {
        setCollapsed(raw === 'true');
      } else if (window.matchMedia('(max-width: 1279px)').matches) {
        // First visit on a tablet-class screen: default the rail to icon-only so
        // the product grid gets the width it needs. Desktop keeps it expanded.
        // Any later user toggle is persisted and wins on subsequent visits.
        setCollapsed(true);
      }
    } catch {
      /* ignore malformed / unavailable storage */
    }
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    // Only persist after hydration so the default state never clobbers a
    // stored preference before the mount effect has read it.
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed, hydrated]);

  /*
   * D177 — the callbacks are STABLE, and that is load-bearing.
   *
   * They used to be defined inside the `useMemo` below, so a new identity was
   * created every time `collapsed`, `mobileOpen` or `hydrated` changed. `Sidebar`
   * has an effect that closes the drawer on navigation:
   *
   *     React.useEffect(() => { closeMobile(); }, [pathname, closeMobile]);
   *
   * so opening the drawer changed `mobileOpen`, which rebuilt the memo, which
   * gave `closeMobile` a new identity, which re-ran that effect, which closed
   * the drawer again. **The button worked; the drawer shut itself in the same
   * tick.** Below the `tab:` cutover — where the rail is hidden and the drawer
   * is the only way to reach navigation — the app had no navigation at all.
   *
   * `useCallback` with no dependencies is safe here because React guarantees
   * the `setState` functions are stable, and both updaters are functional.
   *
   * The lesson is general: a context value handed to `useEffect` dependency
   * arrays is part of the API. An unstable function in it does not merely cost
   * a re-render — it can invert the behaviour of every effect that depends on
   * it, far from where the instability lives.
   */
  const toggleCollapsed = React.useCallback(() => setCollapsed((c) => !c), []);
  const openMobile = React.useCallback(() => setMobileOpen(true), []);
  const closeMobile = React.useCallback(() => setMobileOpen(false), []);

  const value = React.useMemo<SidebarValue>(
    () => ({ collapsed, toggleCollapsed, mobileOpen, openMobile, closeMobile, hydrated }),
    [collapsed, toggleCollapsed, mobileOpen, openMobile, closeMobile, hydrated],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within a SidebarProvider');
  return ctx;
}
