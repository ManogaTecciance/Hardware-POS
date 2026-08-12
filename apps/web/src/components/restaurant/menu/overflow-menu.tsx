'use client';

import { MoreVertical } from 'lucide-react';
import * as React from 'react';

/**
 * Reusable ••• overflow menu used on Menu / Section / Item cards. Handles
 * open/close, click-outside, Escape, and focus-visible. `children` receives an
 * `onSelect` callback each item should call after invoking the action so the
 * menu closes cleanly.
 *
 * Kept in its own file so the three card call-sites don't each re-implement
 * the same open-state + outside-click plumbing.
 */
interface Props {
  label: string;
  disabled?: boolean;
  align?: 'left' | 'right';
  children: (helpers: { close: () => void }) => React.ReactNode;
}

export function OverflowMenu({ label, disabled, align = 'right', children }: Props) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-20 mt-1 w-44 rounded-lg border border-border bg-popover p-1 shadow-pop animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          style={{ animationDuration: '140ms' }}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      ) : null}
    </div>
  );
}

/** Individual entry inside the overflow menu. Prevents duplication of the
 * hover/focus/danger tone triplet across every callsite. */
export function OverflowItem({
  icon,
  label,
  tone = 'default',
  onClick,
  asChild,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: 'default' | 'danger';
  onClick?: () => void;
  asChild?: React.ReactElement;
}) {
  const classes = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs focus-visible:outline-none ${
    tone === 'danger'
      ? 'text-danger hover:bg-danger-soft focus-visible:bg-danger-soft'
      : 'hover:bg-muted focus-visible:bg-muted'
  }`;
  if (asChild) {
    return React.cloneElement(
      asChild as React.ReactElement<Record<string, unknown>>,
      { role: 'menuitem', className: classes, onClick },
      <>
        {icon}
        {label}
      </>,
    );
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className={classes}>
      {icon}
      {label}
    </button>
  );
}
