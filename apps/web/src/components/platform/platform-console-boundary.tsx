'use client';

import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/lib/auth';

/**
 * D55 — the client half of the platform/workspace boundary, at ONE url.
 *
 * Since 2026-08-17 the console lives at /dashboard, the same post-login URL
 * workspace users land on. This boundary sits above the workspace shell in
 * the (app) layout and decides which product renders there:
 *
 *  - a platform admin on /dashboard sees the console (`console` slot) — the
 *    workspace tree below never mounts, so its profile fetch cannot fire and
 *    403 (a platform admin has no workspace);
 *  - a platform admin anywhere else in the shell is sent to /dashboard;
 *  - everyone else falls through to the workspace tree, whose `Protected`
 *    wrapper owns the unauthenticated → /login redirect.
 *
 * The server half (`PlatformBoundaryGuard`) already refuses the wrong token
 * in both directions; nothing here is a security control.
 */
export function PlatformConsoleBoundary({
  children,
  console: consoleSlot,
}: {
  children: React.ReactNode;
  /** What a platform admin sees at /dashboard. */
  console: React.ReactNode;
}) {
  const { session, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPlatformAdmin = session?.isPlatformAdmin === true;
  const onConsoleRoute = pathname === '/dashboard';

  React.useEffect(() => {
    if (loading) return;
    if (isPlatformAdmin && !onConsoleRoute) router.replace('/dashboard');
  }, [loading, isPlatformAdmin, onConsoleRoute, router]);

  if (loading) {
    // An unresolved session is its own state: guessing here would flash the
    // wrong product on every hard refresh.
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (isPlatformAdmin) {
    return onConsoleRoute ? (
      <>{consoleSlot}</>
    ) : (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
