import type { Metadata, Viewport } from 'next';

import { AuthProvider } from '@/lib/auth';
import { ThemeProvider, themeInitScript } from '@/lib/theme';

import './globals.css';

export const metadata: Metadata = {
  title: 'Hardware POS',
  description: 'Cashier sales front-end for hardware retail, synced with QuickBooks Online.',
};

/**
 * Tablet-first viewport (Restaurant POS is used primarily on 10–11" tablets).
 *
 *   • `width=device-width, initial-scale=1` — Next.js's default; restated
 *      explicitly here so `viewport-fit` isn't emitted alone.
 *   • `viewport-fit: cover` — opts the page into the safe-area zone on iOS
 *      Safari and iPadOS split view, which is what makes the
 *      `env(safe-area-inset-*)` paddings in `.safe-*` utilities and in the
 *      POS payment / cart sheets actually take effect. Without it those
 *      padding declarations silently resolve to zero.
 *   • `maximumScale: 1`, `userScalable: false` — the POS is a fixed operating
 *      surface; accidental double-tap zoom during a service push would break
 *      the workflow. Zoom is preserved through the OS accessibility layer
 *      (screen zoom, page magnification), which is the correct place for it.
 *   • `themeColor` for both light and dark schemes so the iPad status bar +
 *      Android Chrome address bar match the app surface.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f7f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint — no flash of wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
