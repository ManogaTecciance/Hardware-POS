'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import { setSupplierStatus } from '@/lib/suppliers/suppliers-api';
import type { Supplier, SupplierStatus } from '@/lib/suppliers/types';

export type LifecycleAction = 'deactivate' | 'reactivate' | 'block';

const COPY: Record<
  LifecycleAction,
  { title: string; body: string; confirm: string; target: SupplierStatus; variant: 'warning' | 'success' | 'destructive' }
> = {
  deactivate: {
    title: 'Deactivate supplier',
    body: 'The supplier will be hidden from new purchasing. All products, purchase history, bills, and payments are preserved, and you can reactivate at any time.',
    confirm: 'Deactivate',
    target: 'INACTIVE',
    variant: 'warning',
  },
  reactivate: {
    title: 'Reactivate supplier',
    body: 'The supplier becomes available for purchasing and product linking again.',
    confirm: 'Reactivate',
    target: 'ACTIVE',
    variant: 'success',
  },
  block: {
    title: 'Block supplier',
    body: 'Blocking prevents new purchasing and shows a warning wherever this supplier appears. All history is preserved. Please record why this supplier is being blocked.',
    confirm: 'Block supplier',
    target: 'BLOCKED',
    variant: 'destructive',
  },
};

export function SupplierLifecycleDialog({
  open,
  action,
  supplier,
  session,
  onClose,
  onDone,
}: {
  open: boolean;
  action: LifecycleAction;
  supplier: Pick<Supplier, 'id' | 'name'>;
  session: Session;
  onClose: () => void;
  onDone: (updated: Supplier) => void;
}) {
  const copy = COPY[action];
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open, action]);

  const submit = async () => {
    if (action === 'block' && !reason.trim()) {
      setError('Enter a reason for blocking this supplier.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await setSupplierStatus(session, supplier.id, copy.target, reason.trim() || undefined);
      onDone(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the supplier.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={copy.title}
      description={supplier.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={copy.variant} onClick={submit} isLoading={busy}>
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        {action === 'block' ? (
          <div className="space-y-1.5">
            <Label htmlFor="block-reason">
              Reason<span className="text-danger"> *</span>
            </Label>
            <Textarea
              id="block-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Repeated quality issues on recent deliveries"
              aria-invalid={!!error || undefined}
              aria-describedby={error ? 'block-reason-error' : undefined}
            />
          </div>
        ) : null}
        {error ? (
          <p id="block-reason-error" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
