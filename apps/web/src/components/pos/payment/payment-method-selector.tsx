'use client';

import {
  Banknote,
  Check,
  Clock,
  Coins,
  CreditCard,
  Landmark,
  Pencil,
  QrCode,
  ScrollText,
  Split,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/** Every payment mode the Payment page can be in. */
export type Mode =
  'CASH' | 'CARD' | 'BANK_TRANSFER' | 'QR_PAYMENT' | 'CHECK' | 'SPLIT' | 'PARTIAL' | 'CREDIT';

export interface MethodOption {
  key: Mode;
  label: string;
  /** Short helper shown under the label in the picker. */
  description: string;
  Icon: LucideIcon;
}

/** Single source of truth for the method list — shared by the selector and page. */
export const PAYMENT_METHODS: MethodOption[] = [
  { key: 'CASH', label: 'Cash', description: 'Pay with cash', Icon: Banknote },
  { key: 'CARD', label: 'Card', description: 'Debit or credit card', Icon: CreditCard },
  { key: 'BANK_TRANSFER', label: 'Bank Transfer', description: 'Direct transfer', Icon: Landmark },
  { key: 'QR_PAYMENT', label: 'QR Payment', description: 'Scan to pay', Icon: QrCode },
  { key: 'CHECK', label: 'Cheque', description: 'Pay by cheque', Icon: ScrollText },
  { key: 'SPLIT', label: 'Split Payment', description: 'Multiple methods', Icon: Split },
  { key: 'PARTIAL', label: 'Partial Payment', description: 'Pay part now', Icon: Coins },
  { key: 'CREDIT', label: 'Credit / Pay Later', description: 'Record as invoice', Icon: Clock },
];

export function getMethod(mode: Mode): MethodOption {
  return PAYMENT_METHODS.find((m) => m.key === mode) ?? PAYMENT_METHODS[0]!;
}

/**
 * Compact selected-payment-method card with a `Change` action. The full method
 * list stays hidden until the cashier taps Change, which opens an accessible
 * bottom sheet — the sheet gives us a thumb-reachable target on tablet and,
 * unlike the old `max-w-md` dialog, widens to `sm:max-w-2xl` so 3-across
 * method tiles have room on iPad landscape without shrinking the icon+label
 * pair. A sheet rather than an inline popover so the unified payment card
 * can keep `overflow: hidden` without clipping it.
 */
export function PaymentMethodSelector({
  value,
  onChange,
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = getMethod(value);

  const select = (mode: Mode) => {
    onChange(mode);
    setOpen(false);
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <selected.Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-tight">{selected.label}</div>
          <div className="truncate text-xs text-muted-foreground">Selected Payment Method</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="shrink-0 text-primary hover:bg-brand-50"
          rightIcon={<Pencil className="h-3.5 w-3.5" />}
        >
          Change
        </Button>
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Choose payment method"
        className="sm:max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      >
        {/* 2-across on portrait tablet + phone, 3-across on landscape tablet
            (`tab:`, 900px+). 4-across (the old grid at desktop widths) was
            cramped for a tile that carries icon + label + description; the
            three-column landscape layout gives PAYMENT_METHODS' eight
            entries room to breathe over three rows. */}
        <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-2 gap-3 tab:grid-cols-3">
          {PAYMENT_METHODS.map((m) => {
            const isSelected = m.key === value;
            return (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => select(m.key)}
                className={cn(
                  'relative flex min-h-[5.5rem] flex-col justify-center gap-1 rounded-xl border p-3 text-left transition-colors touch-target-coarse',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  isSelected
                    ? 'border-primary bg-brand-50 text-brand-700'
                    : 'border-border text-foreground hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-2">
                  <m.Icon className="h-5 w-5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
                    {m.label}
                  </span>
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  ) : null}
                </span>
                <span className="truncate pl-7 text-xs text-muted-foreground">{m.description}</span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
