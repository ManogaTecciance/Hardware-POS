import { cn } from '@/lib/utils';

/**
 * The Axlo mark, in the version that is actually legible on the surface behind
 * it (D140).
 *
 * There are two assets and each is drawn for one background:
 *
 *  - `/brand/axlo-icon.svg` fills its two chevrons with `#fff`, so it reads on
 *    a dark surface and DISAPPEARS on a light one, leaving a bare gradient
 *    slash. It was the only asset the app chrome used, which is why the mark
 *    went missing in light mode.
 *  - `/brand/axlo-icon-light.png` fills them with `#000718` on transparency,
 *    so it reads on a light surface and vanishes into `#1a2433` in dark. It is
 *    the manifest icon's artwork with its transparent padding trimmed off.
 *
 * The trim is what makes the two interchangeable. `web-app-manifest-512x512.png`
 * is a PWA icon: 512x512 with the mark inked across the middle 67% and empty
 * space above and below, which an OS launcher needs and a logo slot does not.
 * Used raw at `h-9 w-auto` it drew a 36x36 box holding a 24px-tall mark beside
 * a 36px-tall one — a third smaller, in a narrower box, so the wordmark beside
 * it shifted on every theme flip. Trimmed, both assets carry the same ink
 * aspect (1.483 vs 1.482) and the same class sizes them identically. The
 * manifest file itself is untouched; its padding is correct for what it is.
 *
 * Swapped in CSS rather than in JavaScript, deliberately: `data-theme` is set
 * by the inline init script before first paint (`lib/theme.ts`), so the right
 * mark is painted immediately with no flash and nothing to rehydrate. Reading
 * the theme in a hook would render one mark on the server and possibly the
 * other on the client.
 *
 * On paper the light mark always wins. The print stylesheet forces a white
 * page by swapping the semantic TOKENS, not `data-theme`, so a dark-theme user
 * printing a screen that shows the mark — the platform console header, which
 * unlike the rail is not hidden at print widths — would otherwise get the
 * white mark on white: the original defect, on paper.
 *
 * NOT for the login screen. Its panels are hard-coded dark (`bg-[#1b2236]`) in
 * both themes, so that page wants the white mark whatever `data-theme` says —
 * using this component there would blank the logo for a light-mode visitor.
 */
export function BrandMark({
  className,
  alt,
}: {
  /** Sizing for both copies — they must match, or the mark resizes on a theme flip. */
  className?: string;
  /**
   * The accessible name. Omitted (the usual case) the mark is decorative: the
   * product name is already beside it as text, and announcing both says
   * "Axlo POS Axlo POS".
   */
  alt?: string;
}) {
  const decorative = alt === undefined;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/axlo-icon-light.png"
        alt={decorative ? '' : alt}
        aria-hidden={decorative ? true : undefined}
        className={cn('block dark:hidden print:block', className)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/axlo-icon.svg"
        alt={decorative ? '' : alt}
        aria-hidden={decorative ? true : undefined}
        className={cn('hidden dark:block print:hidden', className)}
      />
    </>
  );
}
