'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';

/** The API's machine-readable "which workspace?" outcome. */
const WORKSPACE_REQUIRED = 'AUTH_WORKSPACE_REQUIRED';
const ACCOUNT_DEACTIVATED = 'AUTH_ACCOUNT_DEACTIVATED';

/*
 * The login screen is deliberately theme-blind: the hero artwork is dark navy,
 * so the whole page commits to the same palette in both app themes instead of
 * flipping to white around a dark image. Colours are sampled from the artwork
 * (#161d2f canvas; lime → teal ribbon gradient) rather than the app tokens —
 * this page is brand surface, not workspace surface.
 *
 * D48: email + password is the only way to sign in. The PIN box that used to
 * sit below the form is gone with its endpoint; PINs still answer the in-POS
 * approval prompts, which are a different feature.
 */
const FIELD_CLASSES =
  'border-white/15 bg-white/[0.06] text-slate-100 placeholder:text-slate-500 focus-visible:ring-teal-300/50';
const LABEL_CLASSES = 'text-slate-200';

function LoginForm() {
  const { isAuthenticated, loginWithEmail, session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [workspace, setWorkspace] = React.useState('');
  const [email, setEmail] = React.useState('owner@hardwarepos.test');
  const [password, setPassword] = React.useState('password123');
  const [error, setError] = React.useState<string | null>(null);
  const [workspaceRequired, setWorkspaceRequired] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!isAuthenticated) return;
    // D55 (2026-08-17): /dashboard is the one post-login URL — the (app)
    // layout's boundary renders the console there for platform admins.
    router.replace('/dashboard');
  }, [isAuthenticated, router]);

  /*
   * A `?workspace=` link is a deliberate instruction (an invite, a bookmark) and
   * is honoured silently — there is no visible field to prefill any more. The
   * old per-device workspace memory went with the field: silently replaying a
   * stale remembered slug would fail a valid login with no visible cause.
   */
  React.useEffect(() => {
    setWorkspace(searchParams.get('workspace')?.trim() || '');
  }, [searchParams]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithEmail(email, password, workspace);
      router.replace('/dashboard');
      return;
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
      } else if (code === ACCOUNT_DEACTIVATED) {
        // Only ever sent after the password verified server-side, so showing
        // the real reason leaks nothing to a password guesser.
        setError('This account has been deactivated. Contact your administrator to restore access.');
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    } finally {
      // Always re-enable: on success the router is about to replace the page,
      // and a still-mounted form (e.g. a slow route) must stay usable.
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-svh bg-[#161d2f] text-slate-100">
      {/* Hero panel — brand artwork with the platform pitch. Pure decoration
          around the real form, so it disappears below lg and from the
          accessibility tree. */}
      <section aria-hidden="true" className="relative hidden lg:flex lg:w-[58%] xl:w-[60%]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/login-hero.svg"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Legibility scrim behind the headline only — the artwork stays vivid. */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-[#0d1322]/90 to-transparent" />
        <div className="relative z-10 mt-auto max-w-xl p-12 pb-12">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight text-white">
            Axlo POS:
            <br />
            The Unified Platform for Every Business
          </h2>
          <p className="mt-4 text-lg text-slate-300">
            Sell anything. Manage everything. Grow everywhere.
          </p>
        </div>
      </section>

      {/* Form panel. Compact vertical rhythm on purpose: the whole page must
          fit a laptop viewport without scrolling. */}
      <section className="flex flex-1 items-center justify-center border-l border-white/5 bg-[#1b2236] px-6 py-6">
        <div className="w-full max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/axlo-icon.svg" alt="Axlo POS" className="h-12 w-auto" />
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white">
            Sign In to Axlo POS
          </h1>

          <div className="mt-6 space-y-3.5">
            {/* The workspace is identified from the email. This field exists only
                for the rare email that lives in more than one workspace, and only
                appears when the server says so (AUTH_WORKSPACE_REQUIRED). */}
            {workspaceRequired ? (
              <div className="space-y-1.5">
                <Label htmlFor="workspace" className={LABEL_CLASSES}>
                  Workspace
                </Label>
                <Input
                  id="workspace"
                  className={FIELD_CLASSES}
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="e.g., cafe-pos"
                  autoComplete="organization"
                  aria-describedby="workspace-hint"
                  aria-invalid
                />
                <p id="workspace-hint" className="text-xs text-slate-400">
                  Required: this email belongs to more than one workspace.
                </p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="email" className={LABEL_CLASSES}>
                Email
              </Label>
              <Input
                id="email"
                className={FIELD_CLASSES}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className={LABEL_CLASSES}>
                Password
              </Label>
              <Input
                id="password"
                className={FIELD_CLASSES}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <Button
              className="mt-1 w-full rounded-full bg-gradient-to-r from-[#c3f53c] to-[#2fd9c2] font-semibold text-[#10162a] shadow-[0_0_24px_rgba(97,224,167,0.35)] hover:opacity-90 active:opacity-80"
              size="lg"
              disabled={busy}
              onClick={() => void signIn()}
            >
              Sign in
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          ) : null}

          {/* suppressHydrationWarning: the year is computed at render time, and a
              page built in December can be served in January. */}
          <p suppressHydrationWarning className="mt-8 text-center text-xs text-slate-500">
            Copyright © {new Date().getFullYear()} Axlo POS — All rights reserved.
          </p>
        </div>
      </section>
    </main>
  );
}

/**
 * `useSearchParams` forces a Suspense boundary on a statically prerendered route.
 *
 * Slice 8.2 added `?workspace=` prefill, which is what pulled the hook in. Next
 * fails the build rather than silently opting the page out of prerendering, so the
 * boundary is explicit. The fallback shares the page's committed navy so the
 * artwork never flashes against a white frame.
 */
export default function LoginPage() {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-svh items-center justify-center bg-[#161d2f] p-4">
          <p className="text-sm text-slate-400">Loading…</p>
        </main>
      }
    >
      <LoginForm />
    </React.Suspense>
  );
}
