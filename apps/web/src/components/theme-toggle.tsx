'use client';

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
  { mode: 'system', label: 'System', icon: Monitor },
];

/**
 * Theme preference control. A small radio-group segmented control so the choice
 * (light / dark / system) is always visible and each option is individually
 * labelled for assistive tech — colour is never the only signal.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme preference"
      className={cn('inline-flex items-center gap-0.5 rounded-xl border border-border bg-canvas p-0.5', className)}
    >
      {OPTIONS.map((o) => {
        const selected = o.mode === mode;
        return (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${o.label} theme`}
            title={`${o.label} theme`}
            onClick={() => setMode(o.mode)}
            className={cn(
              // 32px on mouse for the compact segmented look; `touch-target-coarse`
              // grows each option to 44px on touch input so the control is usable
              // in the profile menu on tablet-portrait.
              'touch-target-coarse flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
              selected
                ? 'bg-surface text-primary shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <o.icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
