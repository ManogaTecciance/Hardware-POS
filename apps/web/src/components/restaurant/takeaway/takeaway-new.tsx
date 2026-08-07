'use client';

import { Minus, Plus, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import {
  menuItems as menuItemsApi,
  menuSections,
  menus,
  takeaway as takeawayApi,
} from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type {
  MenuItemView,
  MenuView,
  SectionView,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

interface DraftLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: string;
  quantity: number;
  specialInstructions: string;
}

/**
 * New-takeaway form. A compact variant of the dine-in OrderEntry: no modifier
 * dialog and no rounds — takeaway is submitted once, with the customer's
 * details captured up-front.
 */
export function TakeawayNew({ session, branchId }: Props) {
  const router = useRouter();
  const [menuList, setMenuList] = React.useState<MenuView[]>([]);
  const [sectionsByMenu, setSectionsByMenu] = React.useState<Map<string, SectionView[]>>(new Map());
  const [itemsBySection, setItemsBySection] = React.useState<Map<string, MenuItemView[]>>(new Map());
  const [selectedMenuId, setSelectedMenuId] = React.useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const [customerName, setCustomerName] = React.useState('');
  const [customerPhone, setCustomerPhone] = React.useState('');
  const [pickupAt, setPickupAt] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [draft, setDraft] = React.useState<DraftLine[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [idempotencyKey] = React.useState(() => cryptoRandomKey());

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await menus.list(session, branchId, false);
        const active = rows.filter((m) => m.isActive);
        const secs = await Promise.all(
          active.map((m) => menuSections.list(session, m.id).catch(() => [])),
        );
        const sectionsMap = new Map<string, SectionView[]>();
        const allSecIds: string[] = [];
        active.forEach((m, i) => {
          const activeSecs = (secs[i] ?? [])
            .filter((s) => s.isActive)
            .sort((a, b) => a.position - b.position);
          sectionsMap.set(m.id, activeSecs);
          for (const s of activeSecs) allSecIds.push(s.id);
        });
        const itemLists = await Promise.all(
          allSecIds.map((id) => menuItemsApi.list(session, id, false).catch(() => [])),
        );
        const itemsMap = new Map<string, MenuItemView[]>();
        allSecIds.forEach((id, i) => {
          const items = (itemLists[i] ?? [])
            .filter((it) => it.isActive)
            .sort((a, b) => a.position - b.position);
          itemsMap.set(id, items);
        });
        if (cancelled) return;
        setMenuList(active);
        setSectionsByMenu(sectionsMap);
        setItemsBySection(itemsMap);
        const first = active[0];
        if (first) {
          setSelectedMenuId(first.id);
          const firstSec = sectionsMap.get(first.id)?.[0];
          if (firstSec) setSelectedSectionId(firstSec.id);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const currentSections = selectedMenuId ? sectionsByMenu.get(selectedMenuId) ?? [] : [];
  const currentItems = selectedSectionId ? itemsBySection.get(selectedSectionId) ?? [] : [];

  const add = (item: MenuItemView) => {
    setDraft((rows) => [
      ...rows,
      {
        key: cryptoRandomKey(),
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.basePrice,
        quantity: 1,
        specialInstructions: '',
      },
    ]);
  };
  const changeQty = (key: string, delta: number) =>
    setDraft((r) =>
      r.map((row) => (row.key === key ? { ...row, quantity: row.quantity + delta } : row))
        .filter((row) => row.quantity > 0),
    );
  const remove = (key: string) => setDraft((r) => r.filter((row) => row.key !== key));
  const setInstructions = (key: string, val: string) =>
    setDraft((r) => r.map((row) => (row.key === key ? { ...row, specialInstructions: val } : row)));

  const subtotal = draft.reduce((s, r) => s + r.quantity * Number(r.unitPrice), 0);

  const submit = async () => {
    if (draft.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await takeawayApi.create(session, {
        branchId,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        pickupAt: pickupAt ? new Date(pickupAt).toISOString() : undefined,
        notes: notes.trim() || undefined,
        idempotencyKey,
        items: draft.map((r) => ({
          menuItemId: r.menuItemId,
          quantity: r.quantity,
          specialInstructions: r.specialInstructions.trim() || undefined,
        })),
      });
      router.push('/takeaway');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to place order');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading menu…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        {menuList.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              No active menu configured.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {menuList.map((m) => (
                <Pill
                  key={m.id}
                  label={m.name}
                  active={m.id === selectedMenuId}
                  onClick={() => {
                    setSelectedMenuId(m.id);
                    const firstSec = sectionsByMenu.get(m.id)?.[0];
                    setSelectedSectionId(firstSec?.id ?? null);
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2 border-l-2 border-border pl-3">
              {currentSections.map((s) => (
                <Pill
                  key={s.id}
                  label={s.name}
                  active={s.id === selectedSectionId}
                  onClick={() => setSelectedSectionId(s.id)}
                />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {currentItems.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => add(it)}
                  className="flex flex-col rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary"
                >
                  <span className="text-sm font-semibold">{it.name}</span>
                  {it.description ? (
                    <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {it.description}
                    </span>
                  ) : null}
                  <span className="mt-2 text-sm font-semibold text-primary">
                    {formatMoney(it.basePrice)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="space-y-3">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <LabelledInput
              id="cust-name"
              label="Name"
              value={customerName}
              onChange={setCustomerName}
              placeholder="Walk-in — leave blank"
            />
            <LabelledInput
              id="cust-phone"
              label="Phone"
              value={customerPhone}
              onChange={setCustomerPhone}
              placeholder="e.g. 077-1234567"
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="pickup-at">
                Pickup time
              </label>
              <Input
                id="pickup-at"
                type="datetime-local"
                value={pickupAt}
                onChange={(e) => setPickupAt(e.target.value)}
              />
            </div>
            <LabelledInput
              id="notes"
              label="Notes"
              value={notes}
              onChange={setNotes}
              placeholder="Optional"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Order</CardTitle>
            <span className="text-sm font-semibold">{formatMoney(subtotal)}</span>
          </CardHeader>
          <CardContent className="space-y-3">
            {draft.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Tap items on the left to build the order.
              </p>
            ) : (
              <ul className="space-y-3">
                {draft.map((r) => (
                  <li key={r.key} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between">
                      <p className="text-sm font-medium">{r.name}</p>
                      <button
                        type="button"
                        onClick={() => remove(r.key)}
                        aria-label="Remove line"
                        className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="inline-flex items-center gap-1">
                        <QtyBtn onClick={() => changeQty(r.key, -1)} aria-label="Decrease">
                          <Minus className="h-4 w-4" />
                        </QtyBtn>
                        <span className="min-w-6 text-center text-sm font-semibold">
                          {r.quantity}
                        </span>
                        <QtyBtn onClick={() => changeQty(r.key, +1)} aria-label="Increase">
                          <Plus className="h-4 w-4" />
                        </QtyBtn>
                      </div>
                      <span className="text-sm font-semibold">
                        {formatMoney(r.quantity * Number(r.unitPrice))}
                      </span>
                    </div>
                    <Input
                      placeholder="Special instructions"
                      value={r.specialInstructions}
                      onChange={(e) => setInstructions(r.key, e.target.value)}
                      className="mt-2 h-9 text-sm"
                    />
                  </li>
                ))}
              </ul>
            )}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex gap-2">
              <Button asChild variant="ghost" fullWidth>
                <Link href="/takeaway">Cancel</Link>
              </Button>
              <Button
                fullWidth
                leftIcon={<Send className="h-4 w-4" />}
                onClick={submit}
                isLoading={submitting}
                disabled={draft.length === 0}
              >
                Place order
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center rounded-full px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-foreground hover:bg-border'
      }`}
    >
      {label}
    </button>
  );
}

function QtyBtn({
  children,
  onClick,
  ...aria
}: {
  children: React.ReactNode;
  onClick: () => void;
  'aria-label': string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...aria}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
    >
      {children}
    </button>
  );
}

function LabelledInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function cryptoRandomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
