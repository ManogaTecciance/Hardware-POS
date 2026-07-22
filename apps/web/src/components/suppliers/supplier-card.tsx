'use client';

import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { Menu } from '@/components/ui/menu';
import type { SupplierAccess } from '@/lib/suppliers/access';
import { formatBalance } from '@/lib/suppliers/format';
import type { SupplierListItem } from '@/lib/suppliers/types';

import { PreferredBadge, SupplierQuickBooksBadge, SupplierStatusBadge } from './supplier-badges';
import { SupplierAvatar } from './supplier-avatar';
import { buildSupplierMenuItems } from './supplier-menu-items';
import type { SupplierAction } from './use-supplier-action-dialogs';

/** Card representation used on portrait tablets and mobile (no data table). */
export function SupplierCard({
  item,
  access,
  request,
}: {
  item: SupplierListItem;
  access: SupplierAccess;
  request: (action: SupplierAction, t: { id: string; name: string }) => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <SupplierAvatar name={item.name} logoUrl={item.logoUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link
                href={`/suppliers/${item.id}`}
                className="block truncate font-medium text-foreground hover:text-primary hover:underline"
              >
                {item.name}
              </Link>
              <div className="text-xs text-muted-foreground">{item.code}</div>
            </div>
            <Menu label={`Actions for ${item.name}`} items={buildSupplierMenuItems(item, access, request)} />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <SupplierStatusBadge status={item.status} />
            <SupplierQuickBooksBadge status={item.qbStatus} />
            {item.isPreferred ? <PreferredBadge /> : null}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Main contact</dt>
              <dd className="truncate">{item.mainContactName ?? '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Outstanding</dt>
              <dd className="tabular-nums">
                {item.financialsAvailable ? formatBalance(item.outstandingBalance) : 'Not synced'}
              </dd>
            </div>
          </dl>

          <Link
            href={`/suppliers/${item.id}`}
            className="mt-3 inline-flex h-11 items-center text-sm font-medium text-primary hover:underline"
          >
            View supplier →
          </Link>
        </div>
      </div>
    </Card>
  );
}
