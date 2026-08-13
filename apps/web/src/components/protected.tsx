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
     * them staring at a broken sidebar. Send them to their own console instead.
     * The reverse redirect lives in `app/platform/layout.tsx`.
     */
    if (isPlatformAdmin) router.replace('/platform');
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
