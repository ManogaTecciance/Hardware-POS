'use client';

import { useRouter } from 'next/navigation';
import {
  FileText,
  LayoutDashboard,
  Link2,
  Package,
  PackagePlus,
  ReceiptText,
  Search,
  Settings,
  ShoppingCart,
  Undo2,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint: string;
  href: string;
  icon: LucideIcon;
  keywords: string;
  /** D93 — an array means any-of, matching the nav gate. */
  permission?: Permission | readonly Permission[];
}

/** D93 — see `holdsAnyOf` in lib/nav.ts; the same rule, and the same reason. */
function holdsAnyOf(
  permission: Permission | readonly Permission[] | undefined,
  hasPermission: (permission: Permission) => boolean,
): boolean {
  if (permission === undefined) return true;
  if (!Array.isArray(permission)) return hasPermission(permission as Permission);
  for (const candidate of permission as readonly Permission[]) {
    if (hasPermission(candidate)) return true;
  }
  return false;
}

const COMMANDS: Command[] = [
  /*
   * D93 — the same any-of gate as the POS rail entry, for the same reason: a
   * restaurant till holds TAKEAWAY_CREATE and not SALE_CREATE, and Ctrl+K was
   * hiding the only other way in. The retail wording is untouched (D16); it
   * reads oddly in a food-service workspace, which is noted in D93 rather
   * than fixed by editing a string the Tile Shop depends on.
   */
  { id: 'new-sale', label: 'Start new sale', hint: 'POS', href: '/pos', icon: ShoppingCart, keywords: 'sell checkout cart pos register order takeaway delivery', permission: [Permission.SALE_CREATE, Permission.ORDER_SEND_TO_KITCHEN, Permission.TAKEAWAY_CREATE] },
  { id: 'find-sale', label: 'Find a sale', hint: 'Sales', href: '/sales', icon: ReceiptText, keywords: 'invoice receipt transaction history', permission: Permission.SALE_READ },
  { id: 'new-quote', label: 'Create quotation', hint: 'Quotations', href: '/quotations/new', icon: FileText, keywords: 'quote estimate proposal', permission: Permission.QUOTATION_CREATE },
  { id: 'find-quote', label: 'Find a quotation', hint: 'Quotations', href: '/quotations', icon: FileText, keywords: 'quote estimate pipeline', permission: Permission.QUOTATION_READ },
  { id: 'return', label: 'Process a return', hint: 'Returns', href: '/returns/new', icon: Undo2, keywords: 'refund exchange return', permission: Permission.RETURN_CREATE },
  { id: 'find-product', label: 'Find a product', hint: 'Products', href: '/products', icon: Package, keywords: 'item stock inventory sku barcode', permission: Permission.PRODUCT_READ },
  { id: 'add-product', label: 'Add a product', hint: 'Products', href: '/products/new', icon: PackagePlus, keywords: 'create item new product', permission: Permission.PRODUCT_MANAGE },
  { id: 'find-customer', label: 'Find a customer', hint: 'Customers', href: '/customers', icon: Users, keywords: 'client contact buyer', permission: Permission.CUSTOMER_READ },
  { id: 'add-customer', label: 'Add a customer', hint: 'Customers', href: '/customers/new', icon: UserPlus, keywords: 'create client new customer', permission: Permission.CUSTOMER_MANAGE },
  { id: 'quickbooks', label: 'Open QuickBooks & sync log', hint: 'Integrations', href: '/quickbooks', icon: Link2, keywords: 'accounting sync integration qbo', permission: Permission.QUICKBOOKS_READ },
  { id: 'dashboard', label: 'Go to dashboard', hint: 'Overview', href: '/dashboard', icon: LayoutDashboard, keywords: 'home overview metrics' },
  { id: 'settings', label: 'Open settings', hint: 'System', href: '/settings', icon: Settings, keywords: 'preferences configuration', permission: Permission.SETTINGS_MANAGE },
];

/** Global command search. Opens on Cmd/Ctrl+K or via its trigger; permission-
 *  aware; keyboard-driven listbox with focus restore. */
export function CommandPalette() {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  const available = React.useMemo(
    () => COMMANDS.filter((c) => holdsAnyOf(c.permission, hasPermission)),
    [hasPermission],
  );

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q) || c.hint.toLowerCase().includes(q),
    );
  }, [available, query]);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
    restoreRef.current?.focus?.();
  }, []);

  const show = React.useCallback(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    setOpen(true);
  }, []);

  // Global Cmd/Ctrl+K.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (!o) restoreRef.current = document.activeElement as HTMLElement;
          return !o;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  const go = React.useCallback(
    (cmd: Command | undefined) => {
      if (!cmd) return;
      close();
      router.push(cmd.href);
    },
    [close, router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Tab') {
      // Keep focus trapped on the single interactive input.
      e.preventDefault();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label="Open command search"
        aria-keyshortcuts="Meta+K Control+K"
        className="group flex h-9 items-center gap-2 rounded-xl border border-border bg-canvas px-2.5 text-sm text-muted-foreground transition-colors hover:border-brand-200 hover:text-foreground sm:w-56 md:w-64"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left sm:inline">Search or jump to…</span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex">
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
          <button
            type="button"
            aria-label="Close command search"
            onClick={close}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command search"
            className="dash-enter relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls="command-list"
                aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
                placeholder="Search actions, pages, records…"
                className="h-14 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ul id="command-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
              {results.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No matches for “{query}”.
                </li>
              ) : (
                results.map((c, i) => (
                  <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(c)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                        i === active ? 'bg-brand-50 text-brand-700' : 'hover:bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                          i === active ? 'bg-brand-100 text-brand-700' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <c.icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {c.label}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{c.hint}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border bg-canvas px-1">↑</kbd>
                <kbd className="rounded border border-border bg-canvas px-1">↓</kbd>
                to navigate
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border bg-canvas px-1">↵</kbd>
                to open
                <span className="mx-1">·</span>
                <kbd className="rounded border border-border bg-canvas px-1">esc</kbd>
                to close
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
