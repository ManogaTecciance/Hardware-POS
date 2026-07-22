'use client';

import { Search, X } from 'lucide-react';
import * as React from 'react';

import { ChipRow } from '@/components/ui/chip-row';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SUPPLIER_STATUS_LABELS,
  type SupplierCategoryRef,
  type SupplierSort,
  type SupplierStatus,
  type SuppliersQuery,
} from '@/lib/suppliers/types';

const SORT_LABELS: Record<SupplierSort, string> = {
  name: 'Name (A–Z)',
  outstanding: 'Outstanding balance',
  lastPurchase: 'Last purchase',
  dateAdded: 'Date added',
  pendingActivity: 'Pending activity',
  status: 'Status',
};

interface ToggleFilter {
  key: keyof SuppliersQuery;
  label: string;
  value?: string;
}

const TOGGLES: ToggleFilter[] = [
  { key: 'preferred', label: 'Preferred' },
  { key: 'hasOutstanding', label: 'Outstanding balance' },
  { key: 'overdue', label: 'Overdue payment' },
  { key: 'pendingActivity', label: 'Pending activity' },
];

export function SupplierSearchFilters({
  search,
  onSearchChange,
  query,
  onChange,
  categories,
  activeCount,
  onClear,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  query: SuppliersQuery;
  onChange: (patch: Partial<SuppliersQuery>) => void;
  categories: SupplierCategoryRef[];
  activeCount: number;
  onClear: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <label htmlFor="supplier-search" className="sr-only">
            Search suppliers
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="supplier-search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, code, contact, phone, email, VAT, or QuickBooks vendor…"
            className="pl-10"
          />
        </div>

        <Select
          aria-label="Filter by status"
          value={query.status ?? ''}
          onChange={(e) => onChange({ status: (e.target.value || undefined) as SupplierStatus | undefined })}
          className="w-auto"
        >
          <option value="">All statuses</option>
          {(Object.keys(SUPPLIER_STATUS_LABELS) as SupplierStatus[]).map((s) => (
            <option key={s} value={s}>
              {SUPPLIER_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>

        {categories.length > 0 ? (
          <Select
            aria-label="Filter by product category"
            value={query.categoryId ?? ''}
            onChange={(e) => onChange({ categoryId: e.target.value || undefined })}
            className="w-auto"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : null}

        <Select
          aria-label="Sort suppliers"
          value={query.sort ?? 'name'}
          onChange={(e) => onChange({ sort: e.target.value as SupplierSort })}
          className="w-auto"
        >
          {(Object.keys(SORT_LABELS) as SupplierSort[]).map((s) => (
            <option key={s} value={s}>
              Sort: {SORT_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <ChipRow activeKey={String(activeCount)} ariaLabel="Quick filters" className="flex-1">
          {TOGGLES.map((t) => {
            const on = !!query[t.key];
            return (
              <button
                key={t.key as string}
                type="button"
                data-active={on}
                aria-pressed={on}
                onClick={() => onChange({ [t.key]: on ? undefined : true } as Partial<SuppliersQuery>)}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition-colors',
                  on
                    ? 'border-primary bg-brand-50 text-brand-700'
                    : 'border-border bg-surface text-muted-foreground hover:bg-muted',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </ChipRow>

        {activeCount > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
            Clear filters ({activeCount})
          </button>
        ) : null}
      </div>
    </div>
  );
}
