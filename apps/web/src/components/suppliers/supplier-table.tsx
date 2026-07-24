'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { SupplierAvatar } from './supplier-avatar';
import { SupplierActiveBadge, SupplierQuickBooksBadge } from './supplier-badges';
import { formatBalance, formatLocation } from '@/lib/suppliers/format';
import type { Supplier } from '@/lib/suppliers/types';

/**
 * Vendors table — the QuickBooks vendor fields at a glance. Rows navigate to
 * the vendor profile; all mutations live there.
 */
export function SupplierTable({ rows }: { rows: Supplier[] }) {
  const router = useRouter();

  return (
    <table className="w-full min-w-[860px] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th className="px-4 py-3 font-medium">Name</th>
          <th className="px-4 py-3 font-medium">Company</th>
          <th className="px-4 py-3 font-medium">Email / phone</th>
          <th className="px-4 py-3 font-medium">Location</th>
          <th className="px-4 py-3 text-right font-medium">Opening balance</th>
          <th className="px-4 py-3 font-medium">QuickBooks</th>
          <th className="px-4 py-3 font-medium">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((s) => (
          <tr
            key={s.id}
            onClick={() => router.push(`/suppliers/${s.id}`)}
            className="cursor-pointer transition-colors hover:bg-muted/50"
          >
            <td className="px-4 py-3">
              <div className="flex items-center gap-3">
                <SupplierAvatar name={s.name} size="sm" />
                <span className="font-medium text-foreground">{s.name}</span>
              </div>
            </td>
            <td className="px-4 py-3 text-muted-foreground">{s.company ?? '—'}</td>
            <td className="px-4 py-3">
              <div className="text-foreground">{s.email ?? '—'}</div>
              <div className="text-xs text-muted-foreground">{s.phone ?? ''}</div>
            </td>
            <td className="px-4 py-3 text-muted-foreground">
              {formatLocation(s.city, s.province, s.country)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums">{formatBalance(s.openingBalance)}</td>
            <td className="px-4 py-3">
              <SupplierQuickBooksBadge status={s.quickbooks.status} short />
            </td>
            <td className="px-4 py-3">
              <SupplierActiveBadge isActive={s.isActive} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
