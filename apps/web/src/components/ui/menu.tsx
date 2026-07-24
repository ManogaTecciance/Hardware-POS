'use client';

import Link from 'next/link';
import * as React from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Render a separator above this item. */
  separatorBefore?: boolean;
}

/**
 * Lightweight accessible dropdown menu. Escape / outside-click close, arrow-key
 * navigation, focus returns to the trigger on close. Secondary and destructive
 * actions live here rather than as always-visible buttons.
 */
export function Menu({
  items,
  label = 'More actions',
  triggerClassName,
  align = 'end',
}: {
  items: MenuItem[];
  label?: string;
  triggerClassName?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          triggerClassName,
        )}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-50 mt-1 min-w-52 rounded-xl border border-border bg-surface p-1 shadow-pop',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, i) => {
            const Icon = item.icon;
            const content = (
              <>
                {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
                <span className="flex-1">{item.label}</span>
              </>
            );
            const classes = cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
              item.disabled
                ? 'cursor-not-allowed text-muted-foreground opacity-60'
                : item.danger
                  ? 'text-danger hover:bg-danger-soft'
                  : 'text-foreground hover:bg-muted',
            );
            const close = () => setOpen(false);
            return (
              <React.Fragment key={item.label}>
                {item.separatorBefore && i > 0 ? <div className="my-1 h-px bg-border" /> : null}
                {item.href && !item.disabled ? (
                  <Link href={item.href} role="menuitem" className={classes} onClick={close}>
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onSelect?.();
                    }}
                    className={classes}
                  >
                    {content}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
