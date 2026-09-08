/**
 * Viewport hooks used by tablet-responsive components.
 *
 * We reach for JavaScript viewport awareness sparingly — CSS breakpoints
 * (`md:` / `tab:` / `lg:`) handle 95% of the layout adaptation. These hooks
 * exist for the cases CSS cannot express:
 *
 *   • A component swaps between a `<Drawer>` and a `<Sheet>` primitive
 *     depending on orientation (different DOM, not the same DOM restyled).
 *   • A wizard hides its live-preview rail on portrait and adds a "Preview"
 *     button that opens a Sheet — two different affordances, not one
 *     hidden variant.
 *   • The counter POS renders a sticky bottom bar on portrait but not on
 *     landscape (again, different DOM: the bar simply is not there on
 *     landscape).
 *
 * If you can accomplish the same effect with a `tab:` / `md:` / `lg:`
 * variant, prefer that — it renders correctly on the first paint, whereas
 * a hook resolves after hydration and can flash. These hooks default to a
 * safe SSR value (`false` for narrow-band checks, `'landscape'` for
 * orientation) so the first-paint layout is the "wider" one on desktop.
 */

'use client';

import * as React from 'react';

/** Matches the `--breakpoint-tab: 900px` semantic token declared in globals.css. */
const TABLET_LANDSCAPE_MIN_PX = 900;
/** Matches Tailwind's default `lg` breakpoint. */
const DESKTOP_MIN_PX = 1024;

/**
 * SSR-safe wrapper around `window.matchMedia`.
 *
 * On the server (no `window`), returns the caller's `defaultValue` — so a
 * hydration mismatch cannot flash the wrong layout for one frame. Every
 * caller passes a default that matches the desktop-first render.
 */
export function useMediaQuery(query: string, defaultValue: boolean): boolean {
  const [matches, setMatches] = React.useState<boolean>(defaultValue);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    // Sync initial value (client-only) — differs from `defaultValue` when the
    // real viewport is on the other side of the boundary.
    setMatches(mql.matches);

    // Safari <14 uses `addListener/removeListener`; every current target
    // supports the addEventListener form, but keep the fallback for iPadOS.
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, [query]);

  return matches;
}

/**
 * `true` on tablet landscape or larger (≥900px). Splits POS, wizards, and
 * menu-management three-column-layout users.
 *
 * SSR default: `true` (desktop-first render — the first paint on desktop is
 * correct without waiting for hydration; the first paint on tablet portrait
 * will re-render once, which is acceptable).
 */
export function useIsTabletUp(): boolean {
  return useMediaQuery(`(min-width: ${TABLET_LANDSCAPE_MIN_PX}px)`, true);
}

/** `true` on desktop (≥1024px), matching Tailwind's `lg:` boundary. */
export function useIsDesktop(): boolean {
  return useMediaQuery(`(min-width: ${DESKTOP_MIN_PX}px)`, true);
}

/**
 * `'portrait'` when viewport height >= viewport width, else `'landscape'`.
 *
 * We deliberately use the aspect-ratio media query rather than
 * `screen.orientation` — Chrome exposes `screen.orientation` on desktop, and
 * a maximised window on an ultrawide monitor is "landscape" but the more
 * useful signal for us is "the app is currently taller than it is wide,
 * treat it as portrait". A caller that specifically needs the *device*
 * orientation on tablet should combine this with `useIsTabletUp === false`.
 *
 * SSR default: `'landscape'` — desktop-first render.
 */
export function useOrientation(): 'portrait' | 'landscape' {
  const isPortrait = useMediaQuery('(orientation: portrait)', false);
  return isPortrait ? 'portrait' : 'landscape';
}

/**
 * `true` when the primary pointer is coarse (touch), matching the CSS
 * `@media (pointer: coarse)` rule used in globals.css for hover-latch
 * neutralisation and touch-target uplift.
 *
 * SSR default: `false` — desktop mouse assumption. Components that need a
 * touch-specific affordance (a bigger tap target, a swipe hint) render
 * after hydration; a false-positive on desktop is worse than a
 * false-negative on tablet, where the touch-target CSS still enlarges the
 * element regardless of what this hook returns.
 */
export function usePointerCoarse(): boolean {
  return useMediaQuery('(pointer: coarse)', false);
}
