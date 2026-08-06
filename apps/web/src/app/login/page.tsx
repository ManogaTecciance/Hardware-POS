'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Store } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { recallTenant, recallWorkspace, rememberWorkspace } from '@/lib/workspace-memory';

/** The API's machine-readable "which workspace?" outcome. */
const WORKSPACE_REQUIRED = 'AUTH_WORKSPACE_REQUIRED';

function LoginForm() {
  const { isAuthenticated, loginWithEmail, loginWithPin } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [workspace, setWorkspace] = React.useState('');
  const [email, setEmail] = React.useState('owner@hardwarepos.test');
  const [password, setPassword] = React.useState('password123');
  const [pin, setPin] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [workspaceRequired, setWorkspaceRequired] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  /*
   * Whether this device has been commissioned for PIN sign-in (Slice 8.8). Read
   * in an effect rather than during render: `localStorage` does not exist on the
   * server, and a value that differs between the two is a hydration mismatch.
   * Starting `false` means the hint is the pre-hydration state — the honest one
   * for a device that has never signed in.
   */
  const [pinAvailable, setPinAvailable] = React.useState(false);

  React.useEffect(() => {
    if (isAuthenticated) router.replace('/dashboard');
  }, [isAuthenticated, router]);

  /*
   * Prefill order: an explicit `?workspace=` link wins over whatever this device
   * last used, because a link is a deliberate instruction and the remembered value
   * is only a convenience. Never a password — see `workspace-memory.ts`.
   */
  React.useEffect(() => {
    setWorkspace(searchParams.get('workspace')?.trim() || recallWorkspace());
    setPinAvailable(!!recallTenant());
  }, [searchParams]);

  const go = () => router.replace('/dashboard');

  const tryApi = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      go();
    } catch (err) {
      /*
       * Matched on the machine-readable code, never on the prose: the message is
       * user-facing copy and will be reworded, and a UI that branches on English
       * breaks silently the first time it is.
       */
      const code = err instanceof ApiError ? (err.body as { code?: string }).code : undefined;
      if (code === WORKSPACE_REQUIRED) {
        setWorkspaceRequired(true);
        setError('This email is used in more than one workspace. Enter your workspace to continue.');
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    await loginWithEmail(email, password, workspace);
    // Only remembered once it has actually worked, so a typo is not persisted.
    rememberWorkspace(workspace);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Store className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Hardware POS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to start selling</p>
        </div>

        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="workspace">Workspace</Label>
                <Input
                  id="workspace"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="your-workspace"
                  autoComplete="organization"
                  aria-describedby="workspace-hint"
                  aria-invalid={workspaceRequired || undefined}
                />
                <p id="workspace-hint" className="text-xs text-muted-foreground">
                  {workspaceRequired
                    ? 'Required: this email belongs to more than one workspace.'
                    : 'Optional — leave blank if you only use one workspace.'}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <Button
                className="w-full"
                size="lg"
                disabled={busy}
                onClick={() => void tryApi(signIn)}
              >
                Sign in
              </Button>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="pin">Cashier PIN</Label>
                  <Input
                    id="pin"
                    inputMode="numeric"
                    placeholder="••••"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    aria-describedby={pinAvailable ? undefined : 'pin-hint'}
                  />
                </div>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={busy || pin.length < 4}
                  onClick={() => void tryApi(() => loginWithPin(pin))}
                >
                  PIN sign in
                </Button>
              </div>
              {/* Stated before the attempt rather than after it: the API's answer
                  to an unknown tenant is "Invalid PIN", which blames the cashier
                  for a device that was never commissioned. */}
              {!pinAvailable ? (
                <p id="pin-hint" className="text-xs text-muted-foreground">
                  Available once someone has signed in with an email and password on
                  this device.
                </p>
              ) : null}
            </div>

            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

      </div>
    </main>
  );
}

/**
 * `useSearchParams` forces a Suspense boundary on a statically prerendered route.
 *
 * Slice 8.2 added `?workspace=` prefill, which is what pulled the hook in. Next
 * fails the build rather than silently opting the page out of prerendering, so the
 * boundary is explicit. The fallback mirrors the card's frame so the form does not
 * jump into place once the query string is read.
 */
export default function LoginPage() {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      }
    >
      <LoginForm />
    </React.Suspense>
  );
}
