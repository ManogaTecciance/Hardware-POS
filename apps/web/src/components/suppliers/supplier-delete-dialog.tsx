'use client';

import { AlertTriangle } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Session } from '@/lib/auth';
import {
  deleteSupplier,
  fetchSupplierDeleteDependencies,
} from '@/lib/suppliers/suppliers-api';
import { canDeletePermanently, type Supplier } from '@/lib/suppliers/types';

/**
 * Permanent deletion — allowed only for genuinely unused records. Names the
 * supplier, requires the name typed back, explains it can't be undone, and
 * offers Deactivate when deletion is blocked (never a bare trash icon).
 */
export function SupplierDeleteDialog({
  open,
  supplier,
  session,
  onClose,
  onDeleted,
  onDeactivateInstead,
}: {
  open: boolean;
  supplier: Pick<Supplier, 'id' | 'name'>;
  session: Session;
  onClose: () => void;
  onDeleted: () => void;
  onDeactivateInstead: () => void;
}) {
  const [checking, setChecking] = React.useState(true);
  const [blockers, setBlockers] = React.useState<string[]>([]);
  const [allowed, setAllowed] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    setConfirmText('');
    setError(null);
    fetchSupplierDeleteDependencies(session, supplier.id)
      .then((deps) => {
        if (cancelled) return;
        const eligibility = canDeletePermanently(deps);
        setAllowed(eligibility.allowed);
        setBlockers(eligibility.blockers);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not check the supplier.'))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [open, session, supplier.id]);

  const canConfirm = allowed && confirmText.trim() === supplier.name && !busy;

  const submit = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSupplier(session, supplier.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the supplier.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete supplier permanently"
      footer={
        allowed ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submit} disabled={!canConfirm} isLoading={busy}>
              Delete permanently
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="warning" onClick={onDeactivateInstead}>
              Deactivate instead
            </Button>
          </>
        )
      }
    >
      {checking ? (
        <p className="py-4 text-sm text-muted-foreground">Checking whether this supplier can be deleted…</p>
      ) : allowed ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              This permanently deletes <strong>{supplier.name}</strong>. This cannot be undone.
            </span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-name">
              Type the supplier name to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={supplier.name}
              autoComplete="off"
            />
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <strong>{supplier.name}</strong> can’t be permanently deleted because it {blockers.join(', ')}.
            Deleting suppliers with history would break records that reference them.
          </p>
          <p className="text-sm text-muted-foreground">
            Deactivate the supplier instead — this hides it from new purchasing while preserving all history.
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      )}
    </Dialog>
  );
}
