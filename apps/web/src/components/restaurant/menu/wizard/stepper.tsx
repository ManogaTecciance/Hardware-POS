'use client';

import { Check } from 'lucide-react';
import * as React from 'react';

/**
 * Wizard step indicator — visually consistent with the Hardware Product
 * creation wizard (D41). Renders four stages:
 *   • Completed  — filled teal circle + check icon
 *   • Active     — filled teal circle + number
 *   • Future     — muted circle + number
 *
 * The connector between stages is a hairline that turns teal once the step
 * before it is complete. Respects `prefers-reduced-motion` by disabling the
 * colour transition, per the brief's STEPPER ANIMATION clause.
 */
interface Step {
  index: number;
  label: string;
  detail: string;
}

interface StepperProps {
  steps: Step[];
  currentStep: number;
  onStepClick?: (index: number) => void;
}

export function Stepper({ steps, currentStep, onStepClick }: StepperProps) {
  return (
    <ol
      role="list"
      aria-label="Wizard progress"
      className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-2xl border border-border bg-card p-4"
    >
      {steps.map((s, i) => {
        const status: 'complete' | 'active' | 'future' =
          s.index < currentStep ? 'complete' : s.index === currentStep ? 'active' : 'future';
        const clickable = !!onStepClick && s.index <= currentStep;
        return (
          <React.Fragment key={s.index}>
            <li className="min-w-[10rem] flex-1">
              <button
                type="button"
                onClick={clickable ? () => onStepClick!(s.index) : undefined}
                disabled={!clickable}
                aria-current={status === 'active' ? 'step' : undefined}
                className={`group flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors motion-reduce:transition-none ${
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
                  {status === 'complete' ? <Check className="h-4 w-4" /> : s.index}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[11px] font-medium uppercase tracking-wide ${
                      status === 'future' ? 'text-muted-foreground' : 'text-primary'
                    }`}
                  >
                    Step {s.index}
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
                  s.index < currentStep ? 'bg-primary' : 'bg-border'
                }`}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}
