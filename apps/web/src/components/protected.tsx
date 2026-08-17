'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/lib/auth';

/** Redirects to /login when there is no session. Wraps the authenticated shell. */
export function Protected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading, session } = useAuth();
  const router = useRouter();
  const isPlatformAdmin = session?.isPlatformAdmin === true;

  React.useEffect(() => {
    if (loading) return;
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
    /*
     * D55: a platform admin has no workspace, and the API refuses their token on
     * every route this shell calls — the profile fetch alone would 403 and leave
     * them staring at a broken sidebar. `PlatformConsoleBoundary` normally
     * intercepts them before this mounts; this redirect is defence for any
     * Protected usage outside that boundary. /dashboard is safe: the boundary
     * renders the console there, so this cannot loop.
     */
    if (isPlatformAdmin) router.replace('/dashboard');
  }, [loading, isAuthenticated, isPlatformAdmin, router]);

  if (loading || !isAuthenticated || isPlatformAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
