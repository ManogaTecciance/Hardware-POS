'use client';

import * as React from 'react';

import { PlatformProfileProvider } from '@/lib/platform-profile';

/**
 * Scopes the effective-profile fetch to the product screens (Slice 6C-B.5).
 *
 * Mounted here rather than in the app shell so this slice cannot affect navigation
 * or any non-product route, and so the profile is fetched once for the list, detail
 * and form screens instead of once per screen.
 */
export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return <PlatformProfileProvider>{children}</PlatformProfileProvider>;
}
