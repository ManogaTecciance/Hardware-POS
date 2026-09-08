'use client';

import { Check } from 'lucide-react';
import * as React from 'react';

import type { StepKey } from './wizard-state';

/**
 * Add Product wizard step indicator (D44). Structural twin of the restaurant
 * menu wizard's `stepper.tsx`: filled circle + check for completed, ringed
 * circle for the active step, muted for future steps. Colour transitions
 * disabled under `prefers-reduced-motion`.
 *
 * Only the current step and any past step is clickable — a future step is
 * unreachable until the user has passed validation on the intermediate ones.
 */
interface Step {
  index: number;
  key: StepKey;
  label: string;
}

interface StepperProps {
  steps: Step[];
  currentIndex: number;
  onStepClick?: (index: number) => void;
}

export function Stepper({ steps, currentIndex, onStepClick }: StepperProps) {
  return (
    <ol
      role="list"
      aria-label="Wizard progress"
      className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-2xl border border-border bg-card p-4"
    >
      {steps.map((s, i) => {
        const status: 'complete' | 'active' | 'future' =
          s.index < currentIndex ? 'complete' : s.index === currentIndex ? 'active' : 'future';
        const clickable = !!onStepClick && s.index <= currentIndex;
        return (
          <React.Fragment key={s.key}>
            <li className="min-w-[10rem] flex-1">
              <button
                type="button"
                onClick={clickable ? () => onStepClick!(s.index) : undefined}
                disabled={!clickable}
                aria-current={status === 'active' ? 'step' : undefined}
                // touch-target-coarse: on a tablet a mis-tap on a step
                // silently reverts the operator's work in progress. 44px min
                // on coarse pointers only — mice keep the compact 36px look.
                className={`group flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors touch-target-coarse motion-reduce:transition-none ${
                  status === 'active'
                    ? 'bg-primary/8'
                    : clickable
                      ? 'hover:bg-muted'
                      : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors motion-reduce:transition-none ${
                    status === 'complete'
                      ? 'bg-primary text-primary-foreground'
                      : status === 'active'
                        ? 'bg-primary/15 text-primary ring-2 ring-primary'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {status === 'complete' ? <Check className="h-4 w-4" /> : s.index + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[11px] font-medium uppercase tracking-wide ${
                      status === 'future' ? 'text-muted-foreground' : 'text-primary'
                    }`}
                  >
                    Step {s.index + 1}
                  </span>
                  <span
                    className={`block truncate text-sm font-semibold ${
                      status === 'future' ? 'text-muted-foreground' : ''
                    }`}
                  >
                    {s.label}
                  </span>
                </span>
              </button>
            </li>
            {i < steps.length - 1 ? (
              <li
                aria-hidden="true"
                className={`hidden h-px flex-1 md:block ${
                  s.index < currentIndex ? 'bg-primary' : 'bg-border'
                }`}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}
