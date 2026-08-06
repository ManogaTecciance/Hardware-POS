'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen, Store } from 'lucide-react';
import * as React from 'react';

import { resolveNavigation } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { useSidebar } from '@/lib/sidebar';
import { cn } from '@/lib/utils';

/** Brand lockup shared by the desktop rail and the mobile drawer. */
function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-16 items-center gap-2 border-b border-border',
        collapsed ? 'justify-center px-0' : 'px-6',
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Store className="h-5 w-5" />
      </span>
      {!collapsed ? (
        <span className="text-base font-semibold tracking-tight">Hardware POS</span>
      ) : null}
    </div>
  );
}

/**
 * The nav-item list. Rendered identically by the desktop rail and the mobile
 * drawer; only `collapsed` differs (the drawer is always expanded). When
 * collapsed, labels are hidden, icons are centered and a native tooltip
 * (`title`) surfaces each label.
 */
/**
 * `label` distinguishes the two instances.
 *
 * The desktop rail and the mobile drawer both render this list, so both emit a
 * `<nav>`. Two navigation landmarks sharing one accessible name is a real defect —
 * a screen-reader user gets "Main navigation" twice with no way to tell them
 * apart — and it surfaced as an ambiguous query in the render spec.
 */
function NavList({ collapsed, label }: { collapsed?: boolean; label: string }) {
  const pathname = usePathname();
  const { hasPermission } = useAuth();
  const { profile, status } = useEffectiveProfile();

  // Slice 8: navigation is derived from the tenant's business type and enabled
  // modules as well as the user's permissions. While the profile is unresolved the
  // resolver returns nothing, and the neutral placeholder below is rendered — a
  // restaurant operator must never watch POS and QuickBooks appear and vanish.
  const groups = resolveNavigation({
    businessType: profile?.businessType ?? null,
    enabledModules: profile?.enabledModules ?? null,
    hasPermission,
  });

  if (groups.length === 0) {
    return (
      <nav className="flex-1 overflow-y-auto p-3" aria-label={label}>
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          {status === 'error' ? 'Navigation unavailable' : 'Loading…'}
        </p>
      </nav>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto p-3" aria-label={label}>
      {groups.map((group, gi) => (
        <div key={group.label ?? `group-${gi}`} className={cn(gi > 0 && 'mt-4')}>
          {group.label && !collapsed ? (
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </p>
          ) : null}
          {group.label && collapsed && gi > 0 ? (
            <div className="mx-auto mb-2 h-px w-6 bg-border" aria-hidden />
          ) : null}
          <div className="space-y-1">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group/nav relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    collapsed && 'justify-center gap-0',
                    active
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {/* Active rail accent. */}
                  {active ? (
                    <span
                      className={cn(
                        'absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary',
                        collapsed && 'left-0',
                      )}
                      aria-hidden
                    />
                  ) : null}
                  <item.icon className="h-5 w-5 shrink-0" />
                  {!collapsed ? (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <span className="truncate">{item.label}</span>
                      {/* Text, not colour: the marker has to survive a screen
                          reader and a monochrome display, because it is the only
                          thing distinguishing a shell from a working feature. */}
                      {item.upcoming ? (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Soon
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * The sidebar footer note, per accounting provider (Slice 8.5).
 *
 * This was a hardcoded string asserting QuickBooks was the master for **every**
 * tenant, including ones that have never connected it. A restaurant running
 * entirely on AxloPOS was being told its books lived somewhere they do not.
 *
 * `QUICKBOOKS` keeps the sentence verbatim, so the Tile Shop sidebar is unchanged.
 * `null` renders nothing at all rather than inventing a replacement claim — while
 * the profile is unresolved the app does not yet know what to say, and saying
 * nothing is the only honest option.
 */
function footerNote(accountingProvider: string | null | undefined): string | null {
  switch (accountingProvider) {
    case 'QUICKBOOKS':
      return 'QuickBooks is the inventory & accounting master.';
    case 'NONE':
      return 'Sales and catalogue are managed in AxloPOS.';
    default:
      return null;
  }
}

export function Sidebar() {
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();
  const pathname = usePathname();
  const { profile } = useEffectiveProfile();
  const note = footerNote(profile?.accountingProvider);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  // Close the mobile drawer on Escape (mirrors the dialog overlay idiom).
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMobile();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, closeMobile]);

  return (
    <>
      {/* Desktop rail: collapses to an icon-only strip. */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] md:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <Brand collapsed={collapsed} />
        <NavList collapsed={collapsed} label="Main" />
        {!collapsed && note ? (
          <div className="border-t border-border p-4 text-xs text-muted-foreground">{note}</div>
        ) : null}
        {/* Collapse / expand the rail — preference persists (localStorage). */}
        <div className="border-t border-border p-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              collapsed && 'justify-center gap-0',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-5 w-5 shrink-0" />
            ) : (
              <PanelLeftClose className="h-5 w-5 shrink-0" />
            )}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      </aside>

      {/* Mobile off-canvas drawer. Stays mounted for the slide transition;
          made inert when closed so its links leave the tab order. */}
      <div className="md:hidden" inert={mobileOpen ? undefined : true}>
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeMobile}
          className={cn(
            'fixed inset-0 z-40 bg-slate-900/40 transition-opacity',
            mobileOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-surface transition-transform',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Brand />
          <NavList label="Main (mobile)" />
          {note ? (
            <div className="border-t border-border p-4 text-xs text-muted-foreground">{note}</div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
