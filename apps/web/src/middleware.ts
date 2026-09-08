import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route redirects that must fire before the app renders.
 *
 * `/takeaway*` → `/pos?mode=takeaway` (Pilot Change 2 Slice B).
 *
 * The old Takeaway pages are still on disk during this slice — Slice E
 * deletes them. We redirect at the edge instead of shipping a stub page,
 * so a bookmarked `/takeaway` from before the change opens the new POS
 * workspace immediately with no visible flash. Only the primary route
 * plus the `/new` sub-route are covered; any deeper path would 404 today
 * because none exist. `permanent: false` — this is a soft compatibility
 * shim, not a permanent contract, since a future URL scheme change should
 * be free to move `/pos` too.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/takeaway' || pathname === '/takeaway/new' || pathname.startsWith('/takeaway/')) {
    const url = req.nextUrl.clone();
    url.pathname = '/pos';
    url.searchParams.set('mode', 'takeaway');
    return NextResponse.redirect(url, 307);
  }
  return NextResponse.next();
}

export const config = {
  // Only fire on the /takeaway family — matching every route would run the
  // middleware on the whole app for no benefit.
  matcher: ['/takeaway', '/takeaway/:path*'],
};
