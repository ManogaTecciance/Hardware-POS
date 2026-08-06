'use client';

import { Construction } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The shell for a Restaurant route whose workflow is not built yet (Slice 8.4).
 *
 * ## Why these routes exist at all
 *
 * Navigation, module gating and the workspace shape are what Phase 1 delivers. A
 * navigation entry that 404s reads as a broken application; one that opens a page
 * saying plainly what is and is not built reads as an unfinished one, which is the
 * truth.
 *
 * ## What it must never do
 *
 * No fake data, no mock tables, no order forms that appear to work. Every control
 * that would create restaurant state is absent rather than disabled, because a
 * disabled button still asserts the feature exists and is merely switched off.
 * There is nothing here to click.
 */
export function UpcomingFeature({
  title,
  description,
  capabilities,
}: {
  title: string;
  description: string;
  /** What this screen will do, stated as future work — never as present tense. */
  capabilities: string[];
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />

      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Construction className="h-6 w-6" aria-hidden="true" />
          </span>

          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold">Not implemented in this release</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              This workspace shell is part of the AxloPOS platform foundation.
              Implementation begins in the next Restaurant phases.
            </p>
          </div>

          {capabilities.length > 0 ? (
            <div className="w-full max-w-md text-left">
              <p className="pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Planned for a later phase
              </p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {capabilities.map((capability) => (
                  <li key={capability} className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>{capability}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
