import * as React from 'react';

import { Header } from '@/components/header';
import { ModuleGate } from '@/components/module-gate';
import { PlatformConsoleBoundary } from '@/components/platform/platform-console-boundary';
import { PlatformConsoleScreen } from '@/components/platform/platform-console';
import { Protected } from '@/components/protected';
import { Sidebar } from '@/components/sidebar';
import { PlatformProfileProvider } from '@/lib/platform-profile';
import { PosCartProvider } from '@/lib/pos-cart';
import { ReturnDraftProvider } from '@/lib/return-draft';
import { SidebarProvider } from '@/lib/sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // D55 (2026-08-17): /dashboard is the ONE post-login URL. For a platform
    // admin the boundary renders the console INSTEAD of the workspace shell —
    // mounting the shell would fire a profile fetch their token 403s on.
    <PlatformConsoleBoundary console={<PlatformConsoleScreen />}>
    <Protected>
      {/* Slice 8: one profile fetch for the whole authenticated shell. Navigation,
          the workspace shell and the product screens all read it from here. */}
      <PlatformProfileProvider>
        <SidebarProvider>
          <PosCartProvider>
            <ReturnDraftProvider>
              {/* Viewport-locked shell: the app fills the visible viewport height
                (dvh handles the iPad/Safari dynamic toolbar) and never lets the
                document itself scroll. The header stays pinned for every route
                and `main` owns the only vertical scroll — so a page can either
                scroll normally or, like POS, claim the full height and manage
                its own internal scroll regions. */}
              <div className="flex h-dvh overflow-hidden">
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col">
                  <Header />
                  {/* `pb-safe` sits on top of the padding so the last row of
                      any scrollable page clears the home-indicator on
                      notched iPads. The scroll container itself keeps
                      p-4 / p-6 for actual content padding. */}
                  <main className="min-h-0 flex-1 overflow-y-auto p-4 pb-safe md:p-6">
                    {/* Slice 8.6: one gate for every route, inside `main` so a
                        blocked page keeps the shell it was reached from — the
                        sidebar and header stay usable instead of the operator
                        landing on a dead end. */}
                    <ModuleGate>{children}</ModuleGate>
                  </main>
                </div>
              </div>
            </ReturnDraftProvider>
          </PosCartProvider>
        </SidebarProvider>
      </PlatformProfileProvider>
    </Protected>
    </PlatformConsoleBoundary>
  );
}
