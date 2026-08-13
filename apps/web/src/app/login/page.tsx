'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { recallTenant, recallWorkspace, rememberWorkspace } from '@/lib/workspace-memory';

/** The API's machine-readable "which workspace?" outcome. */
const WORKSPACE_REQUIRED = 'AUTH_WORKSPACE_REQUIRED';

/*
 * The login screen is deliberately theme-blind: the hero artwork is dark navy,
 * so the whole page commits to the same palette in both app themes instead of
 * flipping to white around a dark image. Colours are sampled from the artwork
 * (#161d2f canvas; lime → teal ribbon gradient) rather than the app tokens —
 * this page is brand surface, not workspace surface.
 */
const FIELD_CLASSES =
  'border-white/15 bg-white/[0.06] text-slate-100 placeholder:text-slate-500 focus-visible:ring-teal-300/50';
const LABEL_CLASSES = 'text-slate-200';

/** Crossing rounded ribbons echoing the hero artwork — the Axlo "X" mark. */
function AxloMark() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <defs>
        <linearGradient id="axlo-x" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c3f53c" />
          <stop offset="1" stopColor="#2fd9c2" />
        </linearGradient>
        <linearGradient id="axlo-x-2" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#39d0e8" />
          <stop offset="1" stopColor="#55da98" />
        </linearGradient>
      </defs>
      <path
        d="M8 8 L36 36"
        stroke="url(#axlo-x)"
        strokeWidth="7"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M36 8 L8 36"
        stroke="url(#axlo-x-2)"
        strokeWidth="7"
        strokeLinecap="round"
        fill="none"
        opacity="0.9"
      />
    </svg>
  );
}

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
    <main className="flex min-h-screen bg-[#161d2f] text-slate-100">
      {/* Hero panel — brand artwork with the platform pitch. Pure decoration
          around the real form, so it disappears below lg and from the
          accessibility tree. */}
      <section aria-hidden="true" className="relative hidden lg:flex lg:w-[58%] xl:w-[60%]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/login-hero.webp"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Legibility scrim behind the headline only — the artwork stays vivid. */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-[#0d1322]/90 to-transparent" />
        <div className="relative z-10 mt-auto max-w-xl p-12 pb-14">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight text-white">
            AXLO POS:
            <br />
            The Unified Platform for Every Business
          </h2>
          <p className="mt-4 text-lg text-slate-300">
            Empowering restaurants, hardware stores, and every commerce domain.
          </p>
        </div>
      </section>

      {/* Form panel */}
      <section className="flex flex-1 items-center justify-center border-l border-white/5 bg-[#1b2236] px-6 py-12">
        <div className="w-full max-w-sm">
          <AxloMark />
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">
            Sign In to Axlo POS.
          </h1>

          <div className="mt-8 space-y-4">
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
                aria-invalid={workspaceRequired || undefined}
              />
              <p id="workspace-hint" className="text-xs text-slate-400">
                {workspaceRequired
                  ? 'Required: this email belongs to more than one workspace.'
                  : 'Optional — leave blank if you only use one workspace.'}
              </p>
            </div>
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
              className="mt-2 w-full rounded-full bg-gradient-to-r from-[#c3f53c] to-[#2fd9c2] font-semibold text-[#10162a] shadow-[0_0_24px_rgba(97,224,167,0.35)] hover:opacity-90 active:opacity-80"
              size="lg"
              disabled={busy}
              onClick={() => void tryApi(signIn)}
            >
              Sign in
            </Button>
          </div>

          {/* PIN sign-in for commissioned devices — visually secondary to the
              primary credential flow, same behaviour as before. */}
          <div className="mt-8 space-y-1.5 border-t border-white/10 pt-6">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="pin" className={LABEL_CLASSES}>
                  Cashier PIN
                </Label>
                <Input
                  id="pin"
                  className={FIELD_CLASSES}
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
                className="border-white/15 bg-white/[0.06] text-slate-100 hover:bg-white/10"
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
              <p id="pin-hint" className="text-xs text-slate-400">
                Available once someone has signed in with an email and password on
                this device.
              </p>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="mt-4 text-sm text-red-400">
              {error}
            </p>
          ) : null}

          <p className="mt-10 text-center text-xs text-slate-500">
            Copyright © 2026 Axlo POS — All rights reserved.
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
        <main className="flex min-h-screen items-center justify-center bg-[#161d2f] p-4">
          <p className="text-sm text-slate-400">Loading…</p>
        </main>
      }
    >
      <LoginForm />
    </React.Suspense>
  );
}
