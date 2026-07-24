'use client';

import * as React from 'react';

import type { Session } from '@/lib/auth';
import { fetchSupplier } from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';

import { SupplierDeleteDialog } from './supplier-delete-dialog';
import { SupplierLifecycleDialog, type LifecycleAction } from './supplier-lifecycle-dialog';
import { SupplierQuickBooksMappingDrawer } from './supplier-quickbooks-mapping-drawer';

export type SupplierAction = LifecycleAction | 'delete' | 'map-qb';

type Target = Pick<Supplier, 'id' | 'name'>;

/**
 * Centralises the supplier action dialogs (lifecycle, delete, QuickBooks
 * mapping) so the list and profile share one implementation. Returns a
 * `request(action, target)` opener and the `dialogs` element to render once.
 */
export function useSupplierActionDialogs(
  session: Session | null,
  callbacks: { onChanged: (updated: Supplier) => void; onDeleted: (id: string) => void },
) {
  const [lifecycle, setLifecycle] = React.useState<{ action: LifecycleAction; target: Target } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Target | null>(null);
  const [qbSupplier, setQbSupplier] = React.useState<Supplier | null>(null);

  const request = React.useCallback(
    async (action: SupplierAction, target: Target) => {
      if (action === 'delete') {
        setDeleteTarget(target);
      } else if (action === 'map-qb') {
        if (!session) return;
        // Fetch the full record so the drawer has the current mapping details.
        const full = await fetchSupplier(session, target.id);
        setQbSupplier(full);
      } else {
        setLifecycle({ action, target });
      }
    },
    [session],
  );

  const dialogs = session ? (
    <>
      {lifecycle ? (
        <SupplierLifecycleDialog
          open
          action={lifecycle.action}
          supplier={lifecycle.target}
          session={session}
          onClose={() => setLifecycle(null)}
          onDone={callbacks.onChanged}
        />
      ) : null}

      {deleteTarget ? (
        <SupplierDeleteDialog
          open
          supplier={deleteTarget}
          session={session}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            callbacks.onDeleted(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onDeactivateInstead={() => {
            const t = deleteTarget;
            setDeleteTarget(null);
            if (t) setLifecycle({ action: 'deactivate', target: t });
          }}
        />
      ) : null}

      {qbSupplier ? (
        <SupplierQuickBooksMappingDrawer
          open
          supplier={qbSupplier}
          session={session}
          onClose={() => setQbSupplier(null)}
          onMapped={callbacks.onChanged}
        />
      ) : null}
    </>
  ) : null;

  return { request, dialogs };
}
