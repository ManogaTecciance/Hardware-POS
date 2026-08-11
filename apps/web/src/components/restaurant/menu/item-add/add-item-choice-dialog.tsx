'use client';

import { ChefHat, Package } from 'lucide-react';
import * as React from 'react';

import { Dialog } from '@/components/ui/dialog';

export type AddItemChoice = 'PREPARED' | 'LINKED_PRODUCT';

interface Props {
  onChoose: (choice: AddItemChoice) => void;
  onClose: () => void;
}

/**
 * The very first step of "Add menu item" (Pilot Change 4 Section
 * "Menu → Section → Add Menu Item").
 *
 * Two large touch cards: **Prepared Dish** for a made-in-house item that
 * needs no inventory link (Mix Kottu, Fried Rice) and **Existing Product**
 * for a packaged retail item that the menu should surface (Coca-Cola,
 * bottled water).
 *
 * The dialog itself is intentionally thin — it selects the path and closes.
 * The two forms live in their own components so the discrimination stays
 * visible in every file that touches this flow.
 *
 * Accessibility: `role="radiogroup"` + arrow-key navigation on the two
 * options, Enter to select. Same pattern as the counter-POS Order Type
 * modal so the muscle memory carries over.
 */
export function AddItemChoiceDialog({ onChoose, onClose }: Props) {
  const [focusIdx, setFocusIdx] = React.useState(0);
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  React.useEffect(() => {
    refs.current[focusIdx]?.focus();
  }, [focusIdx]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % 2);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % 2);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="What are you adding?"
      description="Menu items and inventory products are separate concepts — pick the one that fits."
    >
      <div
        role="radiogroup"
        aria-label="Menu item type"
        onKeyDown={onKey}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <Card
          ref={(el) => {
            refs.current[0] = el;
          }}
          tabIndex={focusIdx === 0 ? 0 : -1}
          icon={<ChefHat className="h-6 w-6" />}
          title="Prepared Dish"
          hint="A dish the kitchen makes. No inventory link — set price, station, and modifiers here."
          onClick={() => onChoose('PREPARED')}
        />
        <Card
          ref={(el) => {
            refs.current[1] = el;
          }}
          tabIndex={focusIdx === 1 ? 0 : -1}
          icon={<Package className="h-6 w-6" />}
          title="Existing Product"
          hint="A packaged retail item already in Inventory (Coca-Cola, bottled water). Menu presentation only."
          onClick={() => onChoose('LINKED_PRODUCT')}
        />
      </div>
    </Dialog>
  );
}

interface CardProps {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
  tabIndex: number;
}

const Card = React.forwardRef<HTMLButtonElement, CardProps>(function Card(
  { icon, title, hint, onClick, tabIndex },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={false}
      tabIndex={tabIndex}
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-primary hover:bg-brand-100 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <div className="rounded-lg bg-primary/12 p-2 text-primary group-hover:bg-primary/20">
        {icon}
      </div>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
});
