'use client';

import { Building2, Plus, Search, Users } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useAuth, type Session } from '@/lib/auth';
import {
  platformAdmin,
  type WorkspaceTemplate,
  type WorkspaceView,
} from '@/lib/platform-admin-api';
import { WorkspaceUsers } from '@/components/platform/workspace-users';

/**
 * D55 — the workspace list, and the console's only creation surface.
 *
 * A workspace's template decides which product its users see: the template is
 * a `BusinessType`, and that enum already drives the navigation map, the module
 * set and the role templates. Choosing "Restaurant" here is what makes those
 * users land in the restaurant UI.
 */
export default function PlatformConsolePage() {
  const { session } = useAuth();
  const [workspaces, setWorkspaces] = React.useState<WorkspaceView[]>([]);
  const [templates, setTemplates] = React.useState<WorkspaceTemplate[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  // Debounced copy of `search` — the list query fires on THIS, not on every
  // keystroke. 250 ms, matching the product picker's debounce.
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [openWorkspace, setOpenWorkspace] = React.useState<WorkspaceView | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = React.useCallback(async () => {
    if (!session) return;
    try {
      const [ws, tpl] = await Promise.all([
        platformAdmin.listWorkspaces(session, debouncedSearch.trim() || undefined),
        platformAdmin.templates(session),
      ]);
      setWorkspaces(ws);
      setTemplates(tpl);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
      setStatus('error');
    }
  }, [session, debouncedSearch]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each workspace runs the product its template defines. Platform administrators
            manage accounts and templates — never a workspace&rsquo;s trading data.
          </p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
          New workspace
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or slug…"
          aria-label="Search workspaces"
        />
      </div>

      {status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading workspaces…
          </CardContent>
        </Card>
      ) : status === 'error' ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-6 text-sm">
            <span className="text-danger">{error}</span>
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : workspaces.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No workspaces yet. Create the first one to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setOpenWorkspace(w)}
              className="rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{w.name}</p>
                  <p className="truncate text-xs text-muted-foreground">/{w.slug}</p>
                </div>
                {w.isActive ? null : <Badge variant="neutral">Inactive</Badge>}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {/* A workspace with no profile row runs the legacy default — a
                    real state for tenants created before templates existed. */}
                <span>{w.templateKey ?? 'Legacy default'}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  {w.userCount}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {creating ? (
        <CreateWorkspaceDialog
          session={session}
          templates={templates}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      ) : null}

      {openWorkspace ? (
        <WorkspaceUsers
          session={session}
          workspace={openWorkspace}
          onClose={() => setOpenWorkspace(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

function CreateWorkspaceDialog({
  session,
  templates,
  onClose,
  onCreated,
}: {
  session: Session;
  templates: WorkspaceTemplate[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [templateKey, setTemplateKey] = React.useState(templates[0]?.key ?? '');
  const [ownerName, setOwnerName] = React.useState('');
  const [ownerEmail, setOwnerEmail] = React.useState('');
  const [ownerPassword, setOwnerPassword] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The slug follows the name until the operator edits it themselves.
  const setNameAndSlug = (value: string) => {
    setName(value);
    if (!slugTouched) {
      setSlug(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      );
    }
  };

  const valid =
    name.trim().length >= 2 &&
    // Mirrors the server's rule exactly: hyphen-separated lower-case words,
    // no leading, trailing or doubled hyphen. The server is the authority;
    // matching here just keeps the button honest.
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    !!templateKey &&
    ownerName.trim().length > 0 &&
    ownerEmail.includes('@') &&
    ownerPassword.length >= 8;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await platformAdmin.createWorkspace(session, {
        name: name.trim(),
        slug,
        templateKey,
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPassword,
      });
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the workspace');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New workspace"
      description="The template decides which product this workspace's users see."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving} disabled={!valid}>
            Create workspace
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Template</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {templates.map((t) => {
              const active = t.key === templateKey;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTemplateKey(t.key)}
                  aria-pressed={active}
                  className={
                    'rounded-xl border p-3 text-left text-sm transition-colors ' +
                    (active ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted')
                  }
                >
                  <p className="font-medium">{t.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">Workspace name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setNameAndSlug(e.target.value)}
              placeholder="Seaside Hotel"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-slug">Slug</Label>
            <Input
              id="ws-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              placeholder="seaside-hotel"
            />
          </div>
        </div>

        <div className="space-y-1.5 rounded-xl border border-border p-3">
          <p className="text-sm font-medium">First owner</p>
          <p className="text-xs text-muted-foreground">
            A workspace with no way in is not a workspace, so its owner is created with it.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ws-owner">Name</Label>
              <Input id="ws-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ws-email">Email</Label>
              <Input
                id="ws-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ws-pass">Password</Label>
              <Input
                id="ws-pass"
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
