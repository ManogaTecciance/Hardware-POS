'use client';

import { Search, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { QB_STATUS_LABELS, type SupplierQbStatus, type SuppliersQuery } from '@/lib/suppliers/types';

const QB_OPTIONS = Object.keys(QB_STATUS_LABELS) as SupplierQbStatus[];

/** Search + the vendor filters (active state, QuickBooks status, sort). */
export function SupplierSearchFilters({
  search,
  onSearchChange,
  query,
  onChange,
  activeCount,
  onClear,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  query: SuppliersQuery;
  onChange: (patch: Partial<SuppliersQuery>) => void;
  activeCount: number;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search name, company, email, phone…"
          className="pl-10"
          aria-label="Search vendors"
        />
      </div>

      <Select
        value={query.isActive ?? ''}
        onChange={(e) => onChange({ isActive: e.target.value || undefined })}
        aria-label="Filter by active state"
        className="w-36"
      >
        <option value="">All vendors</option>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </Select>

      <Select
        value={query.qbStatus ?? ''}
        onChange={(e) =>
          onChange({ qbStatus: (e.target.value || undefined) as SupplierQbStatus | undefined })
        }
        aria-label="Filter by QuickBooks status"
        className="w-44"
      >
        <option value="">All QuickBooks</option>
        {QB_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {QB_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>

      <Select
        value={query.sort ?? 'name'}
        onChange={(e) => onChange({ sort: e.target.value as SuppliersQuery['sort'] })}
        aria-label="Sort vendors"
        className="w-40"
      >
        <option value="name">Sort: Name</option>
        <option value="company">Sort: Company</option>
        <option value="dateAdded">Sort: Newest</option>
      </Select>

      {activeCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="h-4 w-4" />
          Clear ({activeCount})
        </Button>
      ) : null}
    </div>
  );
}
