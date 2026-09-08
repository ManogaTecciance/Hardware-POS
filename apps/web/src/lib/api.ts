/**
 * Thin API client for the NestJS backend. Attaches the session bearer token and
 * unwraps the standard `{ data }` envelope. When a request fails with 401 and a
 * refresh token is on hand, the client transparently rotates the session
 * (single-flight) and retries the request once; if the refresh itself fails,
 * the session is cleared and the app returns to the login screen.
 */

import { loadSession, saveSession, type Session, type SessionUser } from './session-store';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export interface ApiErrorShape {
  statusCode: number;
  message: string | string[];
  error: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorShape,
  ) {
    super(Array.isArray(body.message) ? body.message.join(', ') : body.message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  token?: string | null;
  tenantId?: string | null;
  body?: unknown;
  signal?: AbortSignal;
}

// ── token refresh (single-flight) ───────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Rotate the stored session via POST /auth/refresh. Concurrent 401s share one
 * refresh call. Resolves with the new access token, or null if refresh is
 * impossible/failed (caller should treat the original 401 as final).
 */
function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<string | null> {
  const session = loadSession();
  if (!session?.refreshToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!res.ok) return null;
    interface RefreshPayload {
      token: string;
      refreshToken: string;
      user?: Omit<SessionUser, 'permissions'>;
      permissions?: string[];
      branch?: { id: string; name: string } | null;
      register?: { id: string; name: string } | null;
    }
    const json = (await res.json()) as { data?: RefreshPayload } & Partial<RefreshPayload>;
    const data = json.data ?? (json as RefreshPayload);
    if (!data.token || !data.refreshToken) return null;
    const next: Session = {
      ...session,
      token: data.token,
      refreshToken: data.refreshToken,
      // Adopt the server's freshly-resolved identity, not just the tokens: a
      // role rename, a permission change, or a field added since this session
      // was minted (roleName) would otherwise persist stale until sign-out.
      ...(data.user
        ? {
            user: {
              ...session.user,
              ...data.user,
              permissions:
                (data.permissions as SessionUser['permissions'] | undefined) ??
                session.user.permissions,
            },
          }
        : {}),
      // Keep the session's location current (branch/register may be reassigned).
      ...(data.branch !== undefined
        ? { branchId: data.branch?.id ?? null, branchName: data.branch?.name ?? 'No branch assigned' }
        : {}),
      ...(data.register !== undefined
        ? { registerId: data.register?.id ?? null, registerName: data.register?.name ?? '—' }
        : {}),
    };
    saveSession(next);
    return data.token;
  } catch {
    return null;
  }
}

function signOutToLogin(): void {
  saveSession(null);
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

// ── request core ────────────────────────────────────────────────────────────

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = (token: string | null | undefined) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.tenantId) headers['x-tenant-id'] = opts.tenantId;
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  };

  let res = await doFetch(opts.token);

  // Expired access token → refresh once and retry with the new token.
  if (res.status === 401 && opts.token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      res = await doFetch(newToken);
    } else {
      signOutToLogin();
    }
  }

  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (json as ApiErrorShape) ?? { statusCode: res.status, message: res.statusText, error: 'Error' });
  }
  return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
}

/**
 * Authenticated fetch for non-JSON endpoints (file downloads, multipart
 * uploads) with the same refresh-on-401-and-retry behaviour as `request`.
 * The caller owns response parsing.
 */
export async function authorizedFetch(
  path: string,
  session: Pick<Session, 'token' | 'user'>,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        'x-tenant-id': session.user.tenantId,
      },
    });

  let res = await doFetch(session.token);
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      res = await doFetch(newToken);
    } else {
      signOutToLogin();
    }
  }
  return res;
}

export const api = {
  baseUrl: BASE_URL,
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, { ...opts, body }),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};
