'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Lightweight CSS-only tooltip: shows `label` above the wrapped element on
 * hover and keyboard focus. Intended for icon-only buttons whose purpose
 * isn't obvious; pair with an aria-label on the button itself.
 */
export function Tooltip({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap',
          // `foreground` on `canvas` is the page's own text/background pair
          // inverted, so the chip stays readable in both themes. A literal
          // text-white here was invisible in dark mode, where foreground IS white.
          'rounded-lg bg-foreground px-2.5 py-1 text-xs font-medium text-canvas shadow-md',
          'opacity-0 transition-opacity delay-200 duration-150',
          'group-hover/tip:opacity-100 group-focus-within/tip:opacity-100',
        )}
      >
        {label}
      </span>
    </span>
  );
}
