'use client';

import Link from 'next/link';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Menu } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/tooltip';
import type { SupplierAccess } from '@/lib/suppliers/access';
import { formatBalance, formatDate } from '@/lib/suppliers/format';
import type { SupplierListItem } from '@/lib/suppliers/types';

import { PreferredBadge, SupplierQuickBooksBadge, SupplierStatusBadge } from './supplier-badges';
import { SupplierAvatar } from './supplier-avatar';
import { buildSupplierMenuItems } from './supplier-menu-items';
import type { SupplierAction } from './use-supplier-action-dialogs';

function CategoryChips({ item }: { item: SupplierListItem }) {
  const shown = item.categories.slice(0, 2);
  const extra = item.categories.length - shown.length;
  if (item.categories.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <Badge key={c.id} variant="neutral">
          {c.name}
        </Badge>
      ))}
      {extra > 0 ? <Badge variant="neutral">+{extra} more</Badge> : null}
    </div>
  );
}

/** Desktop / laptop data table. Wrapped by the page in `overflow-x-auto`. */
export function SupplierTable({
  rows,
  access,
  request,
}: {
  rows: SupplierListItem[];
  access: SupplierAccess;
  request: (action: SupplierAction, t: { id: string; name: string }) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
        <tr className="border-b border-border text-left text-muted-foreground">
          <th scope="col" className="px-4 py-3 font-medium">Supplier</th>
          <th scope="col" className="px-4 py-3 font-medium">Main contact</th>
          <th scope="col" className="hidden px-4 py-3 font-medium xl:table-cell">Products / categories</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">Outstanding</th>
          <th scope="col" className="hidden px-4 py-3 font-medium xl:table-cell">Pending</th>
          <th scope="col" className="hidden px-4 py-3 font-medium 2xl:table-cell">Last purchase</th>
          <th scope="col" className="hidden px-4 py-3 font-medium xl:table-cell">QuickBooks</th>
          <th scope="col" className="px-4 py-3 font-medium">Status</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id} className="border-b border-border last:border-0 hover:bg-muted/30">
            <td className="px-4 py-3">
              <div className="flex items-center gap-3">
                <SupplierAvatar name={item.name} logoUrl={item.logoUrl} />
                <div className="min-w-0">
                  <Link
                    href={`/suppliers/${item.id}`}
                    className="font-medium text-foreground hover:text-primary hover:underline"
                  >
                    {item.name}
                  </Link>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{item.code}</span>
                    {item.isPreferred ? <PreferredBadge /> : null}
                  </div>
                </div>
              </div>
            </td>
            <td className="px-4 py-3">
              {item.mainContactName ? (
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{item.mainContactName}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{item.mainContactPhone ?? '—'}</span>
                    {item.mainContactEmail ? (
                      <Tooltip label={item.mainContactEmail}>
                        <span className="cursor-default underline decoration-dotted">Email</span>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
              ) : (
                <span className="text-muted-foreground">No contact</span>
              )}
            </td>
            <td className="hidden px-4 py-3 xl:table-cell">
              <CategoryChips item={item} />
            </td>
            <td className="px-4 py-3 text-right">
              {item.financialsAvailable ? (
                <span className="font-medium tabular-nums">{formatBalance(item.outstandingBalance)}</span>
              ) : (
                <Tooltip label="Connect this supplier to QuickBooks to see balances">
                  <span className="cursor-default text-xs text-muted-foreground">Not synced</span>
                </Tooltip>
              )}
            </td>
            <td className="hidden px-4 py-3 xl:table-cell">
              {item.pendingActivityCount > 0 ? (
                <span>
                  {item.pendingActivityCount}
                  {item.overdueActivityCount > 0 ? (
                    <span className="ml-1 text-xs text-danger">({item.overdueActivityCount} overdue)</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="hidden px-4 py-3 text-muted-foreground 2xl:table-cell">
              {formatDate(item.lastPurchaseAt)}
            </td>
            <td className="hidden px-4 py-3 xl:table-cell">
              <SupplierQuickBooksBadge status={item.qbStatus} />
            </td>
            <td className="px-4 py-3">
              <SupplierStatusBadge status={item.status} />
            </td>
            <td className="px-4 py-3">
              <div className="flex items-center justify-end gap-1">
                <Link
                  href={`/suppliers/${item.id}`}
                  className="hidden rounded-lg px-2 py-1 text-sm text-primary hover:underline lg:inline"
                >
                  View
                </Link>
                <Menu
                  label={`Actions for ${item.name}`}
                  items={buildSupplierMenuItems(item, access, request)}
                />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
