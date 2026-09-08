'use client';

import { AlertTriangle } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { EffectiveBusinessProfile, ModuleKey } from '@/lib/platform-api';
import {
  ACCOUNTING_PROVIDER_LABELS,
  BUSINESS_TYPE_LABELS,
  INVENTORY_MODE_LABELS,
  MODULE_LABELS,
  sortModules,
} from '@/lib/platform-labels';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Workspace configuration, **read-only** (Slice 8.7, moved to a Settings tab by D95).
 *
 * ## Why read-only
 *
 * `PATCH /v1/platform/profile` exists and is guarded, but switching a live tenant
 * between inventory modes is not a settings toggle: `platform.errors.ts` documents
 * why `QUICKBOOKS → LOCAL` and `LOCAL → QUICKBOOKS` are both unsafe with stock on
 * hand, and neither has a migration. Showing the configuration is useful on its
 * own — support has no other way to ask what a tenant is running.
 *
 * ## Legacy is not "unconfigured"
 *
 * A tenant with no stored profile resolves to the pre-Slice-4 Tile Shop
 * configuration and is fully supported. This screen says so plainly and offers no
 * prompt to "finish setting up" — there is nothing to finish.
 *
 * ## What D95 removed
 *
 * A "Not included" list of every module the workspace does NOT have, and a
 * paragraph directing the reader to contact support to change it. Both went at
 * the PO's request, for every business template including the Tile Shop's: what
 * a workspace includes is not changeable, so an inventory of the absent was a
 * list of things nobody can act on, under an instruction that could not be
 * carried out.
 *
 * No `PageHeader` here — the Settings page renders one, and two `<h1>`s on a
 * screen is what a screen reader reports as two documents. The SETTINGS_MANAGE
 * refusal is likewise the page's, already returned before any tab renders.
 */
export function WorkspaceTab() {
  const { profile, status } = useEffectiveProfile();

  if (status !== 'ready' || !profile) {
    return (
      <section aria-label="Workspace configuration">
        {status === 'error' ? (
          <Notice
            title="Configuration unavailable"
            body="The workspace configuration could not be read. Check your connection and try again."
          />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground" role="status">
            Loading configuration…
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Workspace configuration" className="space-y-6">
      <ProfileCard profile={profile} />
      <ModulesCard enabledModules={profile.enabledModules} />
    </section>
  );
}

function ProfileCard({ profile }: { profile: EffectiveBusinessProfile }) {
  return (
    <Card className="max-w-3xl">
      <CardContent className="p-6">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <Row label="Business type" value={BUSINESS_TYPE_LABELS[profile.businessType]} />
          <Row
            label="Configuration"
            value={profile.source === 'EXPLICIT' ? 'Set for this workspace' : 'Standard'}
            hint={
              profile.source === 'EXPLICIT'
                ? undefined
                : 'This workspace uses the standard configuration. Nothing needs to be set up.'
            }
          />
          <Row label="Inventory" value={INVENTORY_MODE_LABELS[profile.inventoryMode]} />
          <Row
            label="Accounting"
            value={ACCOUNTING_PROVIDER_LABELS[profile.accountingProvider]}
            hint={
              profile.accountingProvider === 'NONE'
                ? 'Sales and returns are recorded in AxloPOS only.'
                : undefined
            }
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function ModulesCard({ enabledModules }: { enabledModules: readonly ModuleKey[] }) {
  const enabled = sortModules(enabledModules);

  return (
    <Card className="max-w-3xl">
      <CardContent className="space-y-5 p-6">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Included</h2>
          <div className="flex flex-wrap gap-1.5">
            {enabled.map((key) => (
              <Badge key={key} variant="primary">
                {MODULE_LABELS[key]}
              </Badge>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </span>
        <p className="text-sm font-medium text-foreground" role="status">
          {title}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
