'use client';

/**
 * A dining-area filter chip.
 *
 * Shared by the Tables floor plan and the reservation calendar so the same
 * gesture — a scrollable strip of areas with "All" first — means the same
 * thing on both restaurant screens. It was local to the floor plan until the
 * calendar needed the identical control; copying it would have let the two
 * strips drift apart in size and hit area.
 */
export function AreaChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  // h-11 unconditionally: these are touch-priority screens and the extra 8px
  // keeps the chip on the 44px touch-target line even on desktop.
  // `data-active` tells the parent ChipRow which chip to scroll into view
  // when the selection is restored from state.
  // `shrink-0` prevents flex-parent squish inside the scrollable ChipRow.
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-border'
      }`}
    >
      {label}
    </button>
  );
}
