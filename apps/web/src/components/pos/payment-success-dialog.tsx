'use client';

import { CheckCircle2, Clock, Plus, Printer, ReceiptText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatMoney } from '@/lib/utils';
import type { CompletedSale } from '@/lib/sales';

export function SuccessView({
  sale,
  currency,
  printing,
  onPreviewA4,
  onPrintA4,
  onPrintThermal,
  onViewSale,
  onNewSale,
  canPrintA4,
}: {
  sale: CompletedSale;
  currency: string;
  printing: boolean;
  onPreviewA4: () => void;
  onPrintA4: () => void;
  onPrintThermal: () => void;
  /**
   * D166 — D152's capability, which this dialog never consulted.
   *
   * A retail sale is on the roll before this dialog opens, and it was
   * still offering **Print A4 Bill** as its primary action for a document
   * that workspace does not issue — with the receipt demoted to a text
   * link between them.
   */
  canPrintA4: boolean;
  onViewSale?: () => void;
  onNewSale: () => void;
}) {
  return (
    <Dialog open onClose={onNewSale} className="max-w-sm">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="h-8 w-8" />
        </span>
        <h2 className="mt-3 text-lg font-semibold">Payment complete</h2>
        <p className="text-sm text-muted-foreground">Sale {sale.saleNumber}</p>

        <div className="mt-5 w-full space-y-2 rounded-xl border border-border p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount paid</span>
            <span className="font-medium">{formatMoney(sale.paidAmount, currency)}</span>
          </div>
          {sale.balanceAmount > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="font-semibold text-danger">
                {formatMoney(sale.balanceAmount, currency)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between pt-1">
            <span className="text-muted-foreground">Sync status</span>
            <Badge variant="warning">
              <Clock className="h-3.5 w-3.5" />
              Waiting to Sync
            </Badge>
          </div>
        </div>

        <div className="mt-5 grid w-full gap-2">
          {canPrintA4 ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={onPreviewA4}
                  leftIcon={<ReceiptText className="h-4 w-4" />}
                >
                  Preview A4 Bill
                </Button>
                <Button size="lg" onClick={onPrintA4} leftIcon={<Printer className="h-4 w-4" />}>
                  Print A4 Bill
                </Button>
              </div>
              <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
                {onViewSale ? (
                  <button onClick={onViewSale} className="font-medium text-primary hover:underline">
                    View sale
                  </button>
                ) : null}
                <span aria-hidden>·</span>
                <button
                  onClick={onPrintThermal}
                  disabled={printing}
                  className="font-medium hover:underline disabled:opacity-50"
                >
                  {printing ? 'Preparing…' : 'Thermal receipt'}
                </button>
              </div>
            </>
          ) : (
            /*
             * D166 — one bill, so one button. The receipt has already
             * printed itself if the toggle was on; this is the reprint for
             * the customer who asks for a second copy, and it is the
             * PRIMARY action because it is the only document this
             * workspace issues.
             */
            <>
              <Button
                size="lg"
                onClick={onPrintThermal}
                disabled={printing}
                leftIcon={<Printer className="h-4 w-4" />}
              >
                {printing ? 'Preparing…' : 'Print receipt'}
              </Button>
              {onViewSale ? (
                <div className="flex items-center justify-center text-xs text-muted-foreground">
                  <button
                    onClick={onViewSale}
                    className="font-medium text-primary hover:underline"
                  >
                    View sale
                  </button>
                </div>
              ) : null}
            </>
          )}
          <Button
            size="lg"
            onClick={onNewSale}
            leftIcon={<Plus className="h-4 w-4" />}
            className="mt-1"
          >
            New sale
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
