'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Controlled tabs primitive (D44). The parent owns `value`; there is no
 * internal state to race. Inactive `TabsContent` panels stay in the DOM with
 * the `hidden` attribute so focus and form state survive tab flips.
 */
interface Ctx {
  value: string;
  onValueChange: (next: string) => void;
  register: (value: string, node: HTMLButtonElement | null) => void;
  triggers: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}
const TabsCtx = React.createContext<Ctx | null>(null);
const useCtx = (caller: string): Ctx => {
  const c = React.useContext(TabsCtx);
  if (!c) throw new Error(`${caller} must be rendered inside <Tabs>`);
  return c;
};

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (next: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const triggers = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const register = React.useCallback((v: string, n: HTMLButtonElement | null) => {
    if (n) triggers.current.set(v, n);
    else triggers.current.delete(v);
  }, []);
  const ctx = React.useMemo<Ctx>(
    () => ({ value, onValueChange, register, triggers }),
    [value, onValueChange, register],
  );
  return (
    <TabsCtx.Provider value={ctx}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  );
}

export function TabsList({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-1 border-b border-border', className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ctx = useCtx('TabsTrigger');
  const active = ctx.value === value;
  const ref = React.useCallback(
    (n: HTMLButtonElement | null) => ctx.register(value, n),
    [ctx, value],
  );
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Only handle roving-tabindex keys — Tab-out still works.
    const vs = [...ctx.triggers.current.keys()];
    const i = vs.indexOf(ctx.value);
    let next: string | null = null;
    if (e.key === 'ArrowRight') next = vs[(i + 1) % vs.length] ?? null;
    else if (e.key === 'ArrowLeft') next = vs[(i - 1 + vs.length) % vs.length] ?? null;
    else if (e.key === 'Home') next = vs[0] ?? null;
    else if (e.key === 'End') next = vs[vs.length - 1] ?? null;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.onValueChange(value);
      return;
    }
    if (next !== null && next !== ctx.value) {
      e.preventDefault();
      ctx.onValueChange(next);
      queueMicrotask(() => ctx.triggers.current.get(next!)?.focus());
    }
  };
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => ctx.onValueChange(value)}
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex h-10 items-center px-4 text-sm font-medium transition-colors rounded-t-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-primary border-b-2 border-primary -mb-px' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const active = useCtx('TabsContent').value === value;
  return (
    <div
      role="tabpanel"
      hidden={!active}
      className={cn(active && 'animate-in fade-in motion-reduce:animate-none', className)}
      style={active ? { animationDuration: '160ms' } : undefined}
    >
      {children}
    </div>
  );
}
