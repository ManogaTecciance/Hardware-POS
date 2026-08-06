'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock } from 'lucide-react';
import * as React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { moduleForPath } from '@/lib/nav';
import { isModuleEnabled } from '@/lib/platform-api';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Route-level module gating for the authenticated shell (Slice 8.6).
 *
 * Slice 8.5 removed disabled features from the sidebar. That is where a user
 * *goes*, not where a user *can* go: `/quickbooks` is still a bookmark, a browser
 * autocompletion and a link in an old email, and a restaurant tenant reaching it
 * got the full QuickBooks screen wired to endpoints that answer 403. The page was
 * not dangerous — the server never yielded — but it stated that the workspace has
 * a QuickBooks integration, which is the false claim Slice 8 exists to retire.
 *
 * ## Why this is not access control
 *
 * It is a client-side component; anyone can disable it. The server's
 * `ModuleAccessGuard` is the authority and is unchanged. This decides only what a
 * screen *says* when the tenant does not have the feature.
 *
 * ## Unresolved is its own state (D31)
 *
 * A gated route renders nothing while the profile is loading and nothing after a
 * failed fetch. Guessing "probably enabled" would show QuickBooks to a restaurant
 * on every slow network; guessing "probably disabled" would tell a Tile Shop its
 * integration had been switched off. Ungated routes — the dashboard, products,
 * settings — are unaffected by profile failure and render immediately, so a
 * profile outage never blanks the application.
 */
export function ModuleGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, status } = useEffectiveProfile();

  const required = moduleForPath(pathname);
  if (!required) return <>{children}</>;

  if (status !== 'ready' || !profile) {
    return (
      <Notice
        title={status === 'error' ? 'Workspace unavailable' : 'Loading…'}
        body={
          status === 'error'
            ? 'This page could not be opened because the workspace configuration could not be read. Check your connection and try again.'
            : 'Checking what this workspace includes.'
        }
        showHome={status === 'error'}
      />
    );
  }

  if (!isModuleEnabled(profile, required)) {
    return (
      <Notice
        title="Not part of this workspace"
        // Named deliberately vaguely: the operator cannot act on a module key, and
        // "QUICKBOOKS is disabled" reads as a fault to be fixed rather than as a
        // configuration choice their business made.
        body="This feature is not included in your workspace configuration. An owner can change what is enabled in settings."
        showHome
      />
    );
  }

  return <>{children}</>;
}

function Notice({
  title,
  body,
  showHome,
}: {
  title: string;
  body: string;
  showHome: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Lock className="h-6 w-6" aria-hidden="true" />
        </span>

        <div className="space-y-1.5">
          {/* `role="status"` so the swap from "Loading…" is announced rather than
              silently replacing the page a screen-reader user was already on. */}
          <h1 className="text-lg font-semibold" role="status">
            {title}
          </h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{body}</p>
        </div>

        {showHome ? (
          <Link href="/dashboard" className="text-sm font-medium text-primary hover:underline">
            Back to dashboard
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
