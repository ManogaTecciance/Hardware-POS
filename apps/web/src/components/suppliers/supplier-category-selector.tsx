'use client';

import { Check, Plus, Search, X } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SupplierCategoryRef } from '@/lib/suppliers/types';

/**
 * Searchable multi-select for product categories supplied. Selections render as
 * removable chips; the user never leaves the form. `onCreate` (when provided)
 * lets permitted users add a new category inline.
 */
export function SupplierCategorySelector({
  options,
  value,
  onChange,
  onCreate,
}: {
  options: SupplierCategoryRef[];
  value: SupplierCategoryRef[];
  onChange: (next: SupplierCategoryRef[]) => void;
  onCreate?: (name: string) => Promise<SupplierCategoryRef | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const selectedIds = new Set(value.map((c) => c.id));
  const q = query.trim().toLowerCase();
  const filtered = options.filter((o) => !q || o.name.toLowerCase().includes(q));
  const exactExists = options.some((o) => o.name.toLowerCase() === q);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (opt: SupplierCategoryRef) => {
    if (selectedIds.has(opt.id)) onChange(value.filter((c) => c.id !== opt.id));
    else onChange([...value, opt]);
  };

  const create = async () => {
    if (!onCreate || !q) return;
    setCreating(true);
    try {
      const created = await onCreate(query.trim());
      if (created) {
        onChange([...value, created]);
        setQuery('');
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface p-2">
        {value.map((c) => (
          <Badge key={c.id} variant="primary" className="gap-1">
            {c.name}
            <button
              type="button"
              aria-label={`Remove ${c.name}`}
              onClick={() => onChange(value.filter((v) => v.id !== c.id))}
              className="rounded-full hover:text-danger"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </Badge>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {value.length === 0 ? 'Add categories' : 'Add'}
        </button>
      </div>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-2 w-full max-w-sm rounded-2xl border border-border bg-surface p-2 shadow-pop">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories…"
              aria-label="Search categories"
              className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul className="max-h-56 overflow-auto" role="listbox" aria-label="Categories" aria-multiselectable>
            {filtered.map((o) => {
              const on = selectedIds.has(o.id);
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(o)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted',
                      on && 'font-medium text-primary',
                    )}
                  >
                    <span className="flex-1">{o.name}</span>
                    {on ? <Check className="h-4 w-4" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && !onCreate ? (
              <li className="px-3 py-3 text-sm text-muted-foreground">No matching categories.</li>
            ) : null}
            {onCreate && q && !exactExists ? (
              <li>
                <button
                  type="button"
                  onClick={create}
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-primary hover:bg-muted disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {creating ? 'Creating…' : `Create “${query.trim()}”`}
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
