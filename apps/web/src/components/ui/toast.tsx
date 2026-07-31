import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Transient confirmation pinned to the bottom of the screen.
 *
 * Uses a high-contrast card surface rather than a tinted one: the obvious
 * `bg-foreground` + `text-white` pairing is invisible in dark mode (foreground
 * resolves to white there), and a soft tint with tinted text falls below the
 * WCAG AA 4.5:1 minimum in light mode. Tone is carried by the icon and the left
 * accent bar, never by colour alone — WCAG 1.4.1.
 */

export type ToastTone = 'success' | 'warning' | 'danger';

const TONE_ACCENT: Record<ToastTone, string> = {
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
};

export function Toast({
  message,
  tone = 'success',
  className,
}: {
  message: string;
  tone?: ToastTone;
  /** Override placement (e.g. to clear a sticky action bar). */
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-xl',
        'border border-l-4 border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground shadow-pop',
        TONE_ACCENT[tone],
        className,
      )}
    >
      {tone === 'success' ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
      ) : tone === 'warning' ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      ) : (
        <X className="h-4 w-4 shrink-0 text-danger" aria-hidden />
      )}
      {message}
    </div>
  );
}
