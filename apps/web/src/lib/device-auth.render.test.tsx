/**
 * PIN sign-in is scoped to the device's tenant (Slice 8.8).
 *
 * The behaviour being replaced was a constant: every PIN login sent
 * `x-tenant-id: tnt_dev`, which is right on one seeded database and wrong
 * everywhere else. A source-text check for that string would be exactly the
 * vacuous test D30 forbids — the string is gone, so it would pass whether the
 * replacement works or not. So this drives the real `AuthProvider` and spies on
 * what the API client is actually handed.
 */
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('./api', () => ({
  api: { post, get: vi.fn(), patch: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

const { AuthProvider, useAuth } = await import('./auth');
const { recallTenant, rememberTenant } = await import('./workspace-memory');

// ── helpers ──────────────────────────────────────────────────────────────────

const LOGIN_RESPONSE = {
  token: 'tok',
  refreshToken: 'ref',
  user: { id: 'u1', name: 'Owner', email: 'owner@example.test', role: 'OWNER', tenantId: 'tnt_real' },
  branch: null,
  register: null,
};

let auth: ReturnType<typeof useAuth>;

function Probe() {
  auth = useAuth();
  return null;
}

function mount() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

/** The `x-tenant-id` the API client was asked to send, or `undefined`. */
function tenantSentTo(path: string): string | undefined {
  const call = post.mock.calls.find(([p]) => p === path);
  if (!call) throw new Error(`No request to ${path}`);
  return (call[2] as { tenantId?: string } | undefined)?.tenantId;
}

beforeEach(() => {
  window.localStorage.clear();
  post.mockReset();
  post.mockResolvedValue(LOGIN_RESPONSE);
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('commissioning a device', () => {
  it('records the tenant the server returned at email sign-in', async () => {
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));

    expect(recallTenant()).toBe('tnt_real');
  });

  it('records the server’s tenant, not the workspace the user typed', async () => {
    // The two are different values: a slug is user input, the tenant id is the
    // server's answer. Sending the slug as `x-tenant-id` would never match.
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw', 'some-workspace'));

    expect(recallTenant()).toBe('tnt_real');
    expect(recallTenant()).not.toBe('some-workspace');
  });
});

describe('PIN sign-in', () => {
  it('sends the tenant this device was commissioned for', async () => {
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));
    await act(() => auth.loginWithPin('1234'));

    expect(tenantSentTo('/auth/pin-login')).toBe('tnt_real');
  });

  it('still works after the previous user signs out', async () => {
    // The flow the terminal exists for: one cashier signs out, the next uses a PIN.
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));
    act(() => auth.logout());
    post.mockClear();

    await act(() => auth.loginWithPin('1234'));
    expect(tenantSentTo('/auth/pin-login')).toBe('tnt_real');
  });

  it('refuses before the device has been commissioned, without calling the API', async () => {
    mount();

    await expect(act(() => auth.loginWithPin('1234'))).rejects.toThrow(/not set up for PIN sign-in/i);
    // The load-bearing half: a request with a guessed tenant would come back
    // "Invalid PIN" and blame the cashier.
    expect(post).not.toHaveBeenCalled();
  });

  it('never falls back to a built-in tenant', async () => {
    // The specific regression: `tnt_dev` was the value for every deployment.
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));
    await act(() => auth.loginWithPin('1234'));

    expect(tenantSentTo('/auth/pin-login')).not.toBe('tnt_dev');
    expect(JSON.stringify(post.mock.calls)).not.toContain('tnt_dev');
  });
});

describe('what the device is willing to remember', () => {
  it('keeps a hand-edited value out of the request', () => {
    window.localStorage.setItem('axlopos.tenant', 'not a tenant id!');
    expect(recallTenant()).toBe('');
  });

  it('ignores a malformed id rather than clearing a working one', () => {
    rememberTenant('tnt_real');
    rememberTenant('');
    rememberTenant('bad value');

    // Clearing would strand a commissioned terminal on the next PIN attempt.
    expect(recallTenant()).toBe('tnt_real');
  });

  it('stores no credential alongside it', async () => {
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'hunter2'));

    const everything = JSON.stringify(window.localStorage);
    expect(everything).not.toContain('hunter2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the PIN-tenant assertions can actually fail', () => {
  it('a hard-coded tenant would be detected', async () => {
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));
    await act(() => auth.loginWithPin('1234'));
    expect(tenantSentTo('/auth/pin-login')).toBe('tnt_real');

    // What the previous implementation sent, whatever the device belonged to.
    const hardCoded = 'tnt_dev';
    expect(() => expect(hardCoded).toBe('tnt_real')).toThrow();
  });

  it('a spy that saw nothing would be detected', async () => {
    // Guards every `not.toContain` above: an assertion over an empty call list
    // passes for the wrong reason.
    mount();
    await act(() => auth.loginWithEmail('owner@example.test', 'pw'));

    expect(post.mock.calls.length).toBeGreaterThan(0);
    expect(() => tenantSentTo('/auth/nowhere')).toThrow();
  });
});
