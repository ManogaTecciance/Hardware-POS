'use client';

import * as React from 'react';

import { api } from './api';
import { Permission, permissionsForRole } from './permissions';
import {
  loadSession,
  saveSession,
  subscribeSession,
  type Session,
  type SessionUser,
} from './session-store';

export type { Session, SessionUser };

interface LoginResponse {
  token: string;
  refreshToken: string;
  user: Omit<SessionUser, 'permissions'>;
  branch: { id: string; name: string } | null;
  register: { id: string; name: string } | null;
}

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  hasPermission: (permission: Permission) => boolean;
  loginWithEmail: (email: string, password: string, workspace?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function toSession(res: LoginResponse): Session {
  return {
    token: res.token,
    refreshToken: res.refreshToken,
    user: { ...res.user, permissions: permissionsForRole(res.user.role) },
    branchId: res.branch?.id ?? null,
    registerId: res.register?.id ?? null,
    branchName: res.branch?.name ?? 'No branch assigned',
    registerName: res.register?.name ?? '—',
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setSession(loadSession());
    setLoading(false);
    // Keep React state in step with store writes (e.g. refresh-on-401 rotations).
    return subscribeSession(setSession);
  }, []);

  /**
   * Email + password sign-in, optionally scoped to a workspace (Slice 8.2).
   *
   * `workspace` is omitted from the payload when blank rather than sent as `''` —
   * the API distinguishes "no workspace supplied" (fall back to a unique email
   * match) from a workspace that failed validation, and an empty string is the
   * latter.
   */
  const loginWithEmail = React.useCallback(
    async (email: string, password: string, workspace?: string) => {
      const slug = workspace?.trim();
      const res = await api.post<LoginResponse>('/auth/login', {
        email,
        password,
        ...(slug ? { workspace: slug } : {}),
      });
      saveSession(toSession(res));
    },
    [],
  );

  const logout = React.useCallback(() => {
    const current = loadSession();
    // Best-effort server-side revocation; local sign-out never waits on it.
    if (current?.refreshToken) {
      void api
        .post('/auth/logout', { refreshToken: current.refreshToken })
        .catch(() => undefined);
    }
    saveSession(null);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      isAuthenticated: !!session,
      hasPermission: (p) => !!session?.user.permissions.includes(p),
      loginWithEmail,
      logout,
    }),
    [session, loading, loginWithEmail, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
