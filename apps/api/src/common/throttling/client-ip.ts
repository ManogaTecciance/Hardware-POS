import type { Request } from 'express';

/**
 * The client IP a rate limiter may trust (Slice 7.1).
 *
 * ## Why not `req.ip`
 *
 * `req.ip` returns the socket address unless Express `trust proxy` is set, and
 * returns the left-most `X-Forwarded-For` entry when it is. Both are wrong for
 * this purpose:
 *
 *  • Socket address alone: behind a load balancer every request appears to come
 *    from the balancer, so one attacker exhausts the allowance for every user.
 *  • Left-most `X-Forwarded-For`: **entirely attacker-controlled.** Anyone can send
 *    `X-Forwarded-For: 1.2.3.4` and get a fresh allowance per request, which makes
 *    the limiter decorative. This is the single most common rate-limiter bypass.
 *
 * ## The rule
 *
 * `X-Forwarded-For` is a list appended to by each hop: the right-most entry was
 * written by the proxy nearest to us and is therefore the only part we can vouch
 * for. If we know we sit behind exactly `N` trusted proxies, the client's real
 * address is the `N`th entry from the right. Anything further left was supplied by
 * something we do not control.
 *
 * `TRUSTED_PROXY_HOP_COUNT` states that `N`. It defaults to **0**, meaning "no
 * proxy in front — ignore the header entirely and use the socket address". Failing
 * closed like this matters: a deployment that forgets to set it gets a limiter that
 * is too aggressive behind a balancer (visible immediately, and it fails safe),
 * rather than one that is silently bypassable (invisible, and it fails open).
 */
export const TRUSTED_PROXY_HOP_COUNT_ENV = 'TRUSTED_PROXY_HOP_COUNT';

export function resolveClientIp(request: Request, trustedProxyHops: number): string {
  const socketIp = request.socket?.remoteAddress ?? request.ip ?? 'unknown';

  if (trustedProxyHops <= 0) return normalise(socketIp);

  const forwarded = headerValue(request, 'x-forwarded-for');
  if (!forwarded) return normalise(socketIp);

  const hops = forwarded
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (hops.length === 0) return normalise(socketIp);

  // Count from the right. If the header is shorter than the configured hop count
  // the chain is not what we were told to expect, so fall back to the left-most
  // entry we were given rather than reading past the start of the array.
  const index = hops.length - trustedProxyHops;
  const candidate = index >= 0 && index < hops.length ? hops[index] : hops[0];
  return normalise(candidate ?? socketIp);
}

/** Read a header as a single string, tolerating the array form Node may produce. */
function headerValue(request: Request, name: string): string | null {
  const raw = request.headers?.[name];
  if (Array.isArray(raw)) return raw.join(',');
  return typeof raw === 'string' ? raw : null;
}

/**
 * Normalise so the same client cannot occupy two buckets.
 *
 * IPv4-mapped IPv6 (`::ffff:203.0.113.5`) is the same host as `203.0.113.5`;
 * counting them separately would double an attacker's allowance for free. Case is
 * flattened for IPv6 hex.
 */
function normalise(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/** Parse the configured hop count, refusing nonsense rather than guessing. */
export function parseTrustedProxyHops(raw: string | number | undefined): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
