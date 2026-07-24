'use client';

import { AlertTriangle } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Session } from '@/lib/auth';
import { deleteSupplier } from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';

/**
 * Permanent-delete confirmation. The server refuses when the vendor is mapped
 * to QuickBooks; marking inactive is the safe alternative offered in copy.
 */
export function SupplierDeleteDialog({
  open,
  supplier,
  session,
  onClose,
  onDeleted,
}: {
  open: boolean;
  supplier: Pick<Supplier, 'id' | 'name' | 'quickbooks'>;
  session: Session;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const isMapped = supplier.quickbooks.vendorId != null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSupplier(session, supplier.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the vendor.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Delete vendor"
      description={supplier.name}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={busy || isMapped} isLoading={busy}>
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            This permanently removes the vendor from AxloPOS. It does not touch the vendor record in
            QuickBooks. If you just want it out of the way, mark it inactive instead.
          </span>
        </div>
        {isMapped ? (
          <p className="text-sm text-muted-foreground">
            This vendor is mapped to QuickBooks vendor{' '}
            <span className="font-medium text-foreground">{supplier.quickbooks.vendorName}</span> — unmap
            it first, or mark the vendor inactive.
          </p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
