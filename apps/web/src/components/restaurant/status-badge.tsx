import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/restaurant/labels';

/**
 * Map the restaurant tone token (from `labels.ts`) to the shared badge
 * variant. Accessible: never colour-only — the label prop is always rendered
 * with the tone as the sole styling difference.
 */
const TONE_TO_VARIANT: Record<
  BadgeTone,
  'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
> = {
  neutral: 'neutral',
  positive: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  muted: 'neutral',
};

export function StatusBadge({
  label,
  tone,
  icon,
  className,
}: {
  label: string;
  tone: BadgeTone;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge variant={TONE_TO_VARIANT[tone]} className={className} aria-label={label}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>{label}</span>
    </Badge>
  );
}
