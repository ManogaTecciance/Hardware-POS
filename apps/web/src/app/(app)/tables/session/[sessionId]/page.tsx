import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

/**
 * D150 — order entry for a table IS the POS, so this route is a forward.
 *
 * It used to mount `OrderEntry`: a second order-composition screen with its own
 * menu grid, which listed items as name-and-price text because it never had the
 * photo card the POS browser has. Two screens for one job meant every POS
 * improvement — item photos, server-side search, sold-out marking, variants,
 * per-line discounts — had to be built twice or (as happened) reached only the
 * counter, while the waiters who take most of a restaurant's orders looked at
 * the older one.
 *
 * The URL is kept rather than deleted because it is on the floor's bookmarks
 * and in the odd shared link. A server-side redirect, so there is no flash of a
 * screen that no longer exists.
 */
export default async function SessionOrderPage({ params }: PageProps) {
  const { sessionId } = await params;
  redirect(`/pos?mode=dine-in&sessionId=${encodeURIComponent(sessionId)}`);
}
