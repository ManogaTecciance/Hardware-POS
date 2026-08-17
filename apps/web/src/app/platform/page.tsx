import { redirect } from 'next/navigation';

/**
 * D55 (2026-08-17): the console moved to /dashboard — one post-login URL for
 * everyone. The route stays so bookmarks and typed URLs land somewhere real.
 */
export default function PlatformPage(): never {
  redirect('/dashboard');
}
