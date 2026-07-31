'use client';

import * as React from 'react';

import type { RollProfile } from '@/lib/labels-api';
import { cn, formatMoney } from '@/lib/utils';

/**
 * True-to-scale preview of what the roll will look like.
 *
 * Rendered client-side from the same roll geometry the server uses, in real
 * millimetres (CSS `mm` units, scaled for screen) so the operator can sanity
 * check spacing before committing a roll to it. The printed artefact is always
 * the server's ZPL — this is a visual approximation, deliberately not a second
 * layout engine.
 */

export interface PreviewSticker {
  name: string;
  sku: string | null;
  price?: number | null;
}

/** Screen zoom — 1mm of media renders this many CSS pixels. */
const PX_PER_MM = 3.2;

export function LabelPreview({
  profile,
  stickers,
  startOffset = 0,
  maxRows = 4,
  className,
}: {
  profile: RollProfile;
  stickers: PreviewSticker[];
  startOffset?: number;
  maxRows?: number;
  className?: string;
}) {
  // Blank leading slots represent stickers already used off a part-used roll.
  const slots: Array<PreviewSticker | null> = [
    ...Array.from({ length: startOffset }, () => null),
    ...stickers,
  ];

  const rows: Array<Array<PreviewSticker | null>> = [];
  for (let i = 0; i < slots.length; i += profile.columns) {
    rows.push(slots.slice(i, i + profile.columns));
  }
  const shown = rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;

  const mm = (value: number) => `${value * PX_PER_MM}px`;

  return (
    <div className={cn('space-y-2', className)}>
      <div
        className="mx-auto overflow-hidden rounded-lg border border-dashed border-border bg-white p-1"
        style={{ width: mm(profile.webWidthMm) }}
        aria-label="Label roll preview"
      >
        {shown.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="flex"
            style={{ gap: mm(profile.gapXMm), marginBottom: mm(profile.marginTopMm) }}
          >
            {Array.from({ length: profile.columns }, (_, column) => {
              const sticker = row[column];
              return (
                <div
                  key={column}
                  className={cn(
                    'flex flex-col justify-between overflow-hidden rounded-[2px] border',
                    sticker ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50',
                  )}
                  style={{
                    width: mm(profile.stickerWidthMm),
                    height: mm(profile.stickerHeightMm),
                    padding: mm(1.5),
                  }}
                >
                  {sticker ? (
                    <StickerFace profile={profile} sticker={sticker} />
                  ) : (
                    <span className="m-auto text-[8px] text-slate-400">used</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {profile.label} · {profile.webWidthMm}mm media
        {hidden > 0 ? ` · +${hidden} more row${hidden === 1 ? '' : 's'}` : ''}
      </p>
    </div>
  );
}

function StickerFace({ profile, sticker }: { profile: RollProfile; sticker: PreviewSticker }) {
  const code = sticker.sku ?? '';
  return (
    <>
      {profile.content.productName ? (
        <div
          className="truncate font-medium leading-tight text-slate-900"
          style={{ fontSize: profile.stickerWidthMm >= 80 ? 9 : 6 }}
        >
          {sticker.name}
        </div>
      ) : null}

      {/* Bars are indicative only — the printer renders the real symbol. */}
      <div className="flex flex-col items-center justify-center">
        <FakeBars widthMm={profile.stickerWidthMm - 4} heightMm={profile.barcodeHeightMm} />
        {profile.content.humanReadable && code ? (
          <div className="mt-[1px] tracking-widest text-slate-900" style={{ fontSize: 6 }}>
            {code}
          </div>
        ) : null}
      </div>

      <div className="flex items-end justify-between gap-1">
        {profile.content.sku && code ? (
          <span className="truncate text-slate-600" style={{ fontSize: 6 }}>
            {code}
          </span>
        ) : (
          <span />
        )}
        {profile.content.price && sticker.price != null ? (
          <span
            className="shrink-0 font-semibold text-slate-900"
            style={{ fontSize: profile.stickerWidthMm >= 80 ? 8 : 6 }}
          >
            {formatMoney(sticker.price)}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** Decorative barcode stand-in — evenly varied bars at the right footprint. */
function FakeBars({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  const bars = React.useMemo(
    () => Array.from({ length: 34 }, (_, i) => (i % 3 === 0 ? 2 : i % 4 === 0 ? 3 : 1)),
    [],
  );
  return (
    <div
      className="flex items-end justify-center gap-[1px] overflow-hidden"
      style={{ width: widthMm * PX_PER_MM, height: heightMm * PX_PER_MM }}
      aria-hidden
    >
      {bars.map((weight, i) => (
        <span key={i} className="h-full bg-slate-900" style={{ width: weight }} />
      ))}
    </div>
  );
}
