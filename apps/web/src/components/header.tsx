'use client';

import { useRouter } from 'next/navigation';
import { Building2, ChevronDown, LogOut, MonitorSmartphone, PanelLeft } from 'lucide-react';
import * as React from 'react';

import { CommandPalette } from '@/components/command-palette';
import { SyncStatus } from '@/components/sync-status';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useSidebar } from '@/lib/sidebar';
import { cn } from '@/lib/utils';

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function Header() {
  const { session, logout } = useAuth();
  const { openMobile } = useSidebar();
  const router = useRouter();
  if (!session) return null;

  const onLogout = () => {
    logout();
    router.replace('/login');
  };

  return (
    <header className="flex h-16 items-center justify-between gap-3 border-b border-border bg-surface px-4 md:px-6">
      {/* Mobile-only drawer opener — on desktop the rail has its own collapse
          control at the bottom of the sidebar. */}
      <div className="flex min-w-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={openMobile}
          aria-label="Open navigation"
          className="md:hidden"
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2 md:gap-3">
        <CommandPalette />
        <SyncStatus />
        <ThemeToggle className="hidden md:inline-flex" />
        <ProfileMenu
          name={session.user.name}
          role={session.user.role}
          branch={session.branchName}
          register={session.registerName}
          onLogout={onLogout}
        />
      </div>
    </header>
  );
}

function ProfileMenu({
  name,
  role,
  branch,
  register,
  onLogout,
}: {
  name: string;
  role: string;
  branch: string;
  register: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={cn(
          'flex items-center gap-2 rounded-xl border border-transparent p-1 pr-1.5 transition-colors hover:bg-muted',
          open && 'border-border bg-muted',
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">
          {initials(name)}
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs capitalize text-muted-foreground">{role.toLowerCase()}</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop"
        >
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-xs capitalize text-muted-foreground">{role.toLowerCase()}</p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                {branch}
              </p>
              <p className="flex items-center gap-1.5">
                <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden />
                {register}
              </p>
            </div>
          </div>
          <div className="my-1 border-t border-border md:hidden" />
          <div className="flex items-center justify-between px-3 py-2 md:hidden">
            <span className="text-xs font-medium text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-soft focus-visible:bg-danger-soft focus-visible:outline-none"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}
