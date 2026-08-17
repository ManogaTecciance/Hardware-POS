'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

/**
 * D55 — the platform console shell.
 *
 * Deliberately outside the `(app)` group: that layout renders the workspace
 * sidebar, the module gate and the POS cart providers, all of which assume a
 * tenant. A platform admin has none, and every workspace route would refuse
 * their token anyway.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, logout } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    // A workspace user who lands here — a stale bookmark, say — is sent to
    // their own app rather than shown an empty console.
    if (!session.isPlatformAdmin) router.replace('/dashboard');
  }, [session, loading, router]);

  if (loading || !session?.isPlatformAdmin) return null;

  return (
    <div className="min-h-svh bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/axlo-icon.svg" alt="" className="h-8 w-auto" aria-hidden />
            <div>
              <p className="text-base font-semibold tracking-tight">Axlo POS</p>
              <p className="text-xs text-muted-foreground">Workspaces and user administration</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {session.user.name}
            </span>
            <Button variant="outline" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
