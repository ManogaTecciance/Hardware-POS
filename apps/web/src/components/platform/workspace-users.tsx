'use client';

import { KeyRound, Plus } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/auth';
import {
  platformAdmin,
  type WorkspaceUserView,
  type WorkspaceView,
} from '@/lib/platform-admin-api';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTANT'] as const;

/**
 * D55 — user administration for one workspace.
 *
 * This is as deep as the console goes into a workspace: accounts, roles and
 * activation. There is no view here of anything the workspace sells, and the
 * API would refuse one — a platform admin's token is rejected on every
 * workspace route.
 */
export function WorkspaceUsers({
  session,
  workspace,
  onClose,
  onChanged,
}: {
  session: Session;
  workspace: WorkspaceView;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [users, setUsers] = React.useState<WorkspaceUserView[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [resetting, setResetting] = React.useState<WorkspaceUserView | null>(null);

  const load = React.useCallback(async () => {
    try {
      setUsers(await platformAdmin.listUsers(session, workspace.id));
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
      setStatus('error');
    }
  }, [session, workspace.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const setActive = async (user: WorkspaceUserView, isActive: boolean) => {
    await platformAdmin.updateUser(session, workspace.id, user.id, { isActive });
    await load();
    await onChanged();
  };

  const setRole = async (user: WorkspaceUserView, role: string) => {
    await platformAdmin.updateUser(session, workspace.id, user.id, { role });
    await load();
  };

  if (adding) {
    return (
      <AddUserDialog
        session={session}
        workspace={workspace}
        onClose={() => setAdding(false)}
        onCreated={async () => {
          setAdding(false);
          await load();
          await onChanged();
        }}
      />
    );
  }

  if (resetting) {
    return (
      <ResetPasswordDialog
        session={session}
        workspace={workspace}
        user={resetting}
        onClose={() => setResetting(null)}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={workspace.name}
      description={`/${workspace.slug} · ${workspace.templateKey ?? 'Legacy default'} template`}
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add user
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {status === 'loading' ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading users…</p>
        ) : status === 'error' ? (
          <p className="text-sm text-danger">{error}</p>
        ) : (
          users.map((u) => {
            /*
             * A user linked to a custom workspace role (a waiter) keeps an enum
             * role underneath — the seeded waiter is enum CASHIER — and the
             * permission resolver uses the linked role, not the enum. Showing
             * only the enum would tell the operator this waiter is a cashier,
             * so the role actually in force is named separately.
             */
            const workspaceRole = u.roleKey && u.roleKey !== u.role ? u.roleKey : null;
            return (
              <div
                key={u.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {u.name}
                    {u.isActive ? null : (
                      <Badge variant="neutral" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{u.email ?? 'No email'}</p>
                  {workspaceRole ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Workspace role{' '}
                      <span className="font-medium text-foreground">{workspaceRole}</span> — what
                      the API enforces. The role beside is only its fallback.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Select
                    value={u.role}
                    aria-label={`Base role for ${u.name}`}
                    className="w-44"
                    onChange={(e) => void setRole(u, e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<KeyRound className="h-4 w-4" />}
                    onClick={() => setResetting(u)}
                  >
                    Password
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void setActive(u, !u.isActive)}>
                    {u.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}

function AddUserDialog({
  session,
  workspace,
  onClose,
  onCreated,
}: {
  session: Session;
  workspace: WorkspaceView;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState<string>('CASHIER');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const valid = name.trim().length > 0 && email.includes('@') && password.length >= 8;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await platformAdmin.createUser(session, workspace.id, {
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      });
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the user');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a user to ${workspace.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving} disabled={!valid}>
            Create user
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="space-y-1.5">
          <Label htmlFor="u-name">Name</Label>
          <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="u-email">Email</Label>
          <Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="u-pass">Password</Label>
            <Input
              id="u-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-role">Role</Label>
            <Select id="u-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({
  session,
  workspace,
  user,
  onClose,
}: {
  session: Session;
  workspace: WorkspaceView;
  user: WorkspaceUserView;
  onClose: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (password.length < 8 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await platformAdmin.resetPassword(session, workspace.id, user.id, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set a password for ${user.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {done ? null : (
            <Button onClick={() => void submit()} isLoading={saving} disabled={password.length < 8}>
              Set password
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {done ? (
          <p className="text-sm text-success">
            Password set. Give it to {user.name} directly — it is not stored anywhere you can
            read it back.
          </p>
        ) : (
          <>
            {/* Said plainly, because it is true: this is the one console action
                that can reach a workspace's data. */}
            <p className="text-sm text-warning">
              Setting a password lets anyone holding it sign in as {user.name} and see everything
              that account can. This action is recorded on the workspace&rsquo;s audit trail
              against your name.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
