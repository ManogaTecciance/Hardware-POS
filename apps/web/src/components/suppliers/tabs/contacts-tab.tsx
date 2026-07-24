'use client';

import { Mail, Phone, Plus, Star } from 'lucide-react';
import * as React from 'react';

import { SupplierContactForm } from '@/components/suppliers/supplier-contact-form';
import { SupplierEmptyState, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Menu } from '@/components/ui/menu';
import type { Session } from '@/lib/auth';
import {
  deleteSupplierContact,
  fetchSupplierContacts,
  setPrimaryContact,
  updateSupplierContact,
} from '@/lib/suppliers/suppliers-api';
import { CONTACT_TYPE_LABELS, type SupplierContact } from '@/lib/suppliers/types';

export function SupplierContactsTab({
  session,
  supplierId,
  canManage,
  onChanged,
}: {
  session: Session;
  supplierId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [contacts, setContacts] = React.useState<SupplierContact[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SupplierContact | undefined>(undefined);

  const load = React.useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSupplierContacts(session, supplierId)
      .then((c) => !cancelled && setContacts(c))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load contacts.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, supplierId]);

  React.useEffect(() => load(), [load]);

  const afterChange = () => {
    load();
    onChanged();
  };

  const doSetPrimary = async (c: SupplierContact) => {
    await setPrimaryContact(session, supplierId, c.id);
    afterChange();
  };
  const doDeactivate = async (c: SupplierContact) => {
    await updateSupplierContact(session, supplierId, c.id, { ...toInput(c), isActive: false });
    afterChange();
  };
  const doDelete = async (c: SupplierContact) => {
    await deleteSupplierContact(session, supplierId, c.id);
    afterChange();
  };

  if (loading) return <Card><div className="p-6 text-sm text-muted-foreground">Loading contacts…</div></Card>;
  if (error) return <Card><SupplierErrorState message={error} onRetry={load} /></Card>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {contacts.length} contact{contacts.length === 1 ? '' : 's'}
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => { setEditing(undefined); setFormOpen(true); }} leftIcon={<Plus className="h-4 w-4" />}>
            Add contact
          </Button>
        ) : null}
      </div>

      {contacts.length === 0 ? (
        <Card>
          <SupplierEmptyState
            title="No contacts yet"
            description="Add a primary contact so your team knows who to reach."
            action={
              canManage ? (
                <Button size="sm" onClick={() => setFormOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
                  Add contact
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {contacts.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{c.fullName}</span>
                    {c.isPrimary ? (
                      <Badge variant="primary">
                        <Star className="h-3 w-3 fill-current" aria-hidden /> Primary
                      </Badge>
                    ) : null}
                    {!c.isActive ? <Badge variant="neutral">Inactive</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {CONTACT_TYPE_LABELS[c.contactType]}
                    {c.jobTitle ? ` · ${c.jobTitle}` : ''}
                  </div>
                </div>
                {canManage ? (
                  <Menu
                    label={`Actions for ${c.fullName}`}
                    items={[
                      { label: 'Edit contact', onSelect: () => { setEditing(c); setFormOpen(true); } },
                      ...(!c.isPrimary && c.isActive ? [{ label: 'Set as primary', onSelect: () => void doSetPrimary(c) }] : []),
                      ...(c.isActive ? [{ label: 'Deactivate', onSelect: () => void doDeactivate(c) }] : []),
                      { label: 'Delete contact', danger: true, separatorBefore: true, onSelect: () => void doDelete(c) },
                    ]}
                  />
                ) : null}
              </div>
              <div className="mt-3 space-y-1.5 text-sm">
                {c.phone ? (
                  <a href={`tel:${c.phone}`} className="flex items-center gap-2 text-foreground hover:text-primary">
                    <Phone className="h-4 w-4 text-muted-foreground" aria-hidden /> {c.phone}
                  </a>
                ) : null}
                {c.email ? (
                  <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-foreground hover:text-primary">
                    <Mail className="h-4 w-4 text-muted-foreground" aria-hidden /> <span className="truncate">{c.email}</span>
                  </a>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {canManage ? (
        <SupplierContactForm
          open={formOpen}
          session={session}
          supplierId={supplierId}
          contact={editing}
          onClose={() => setFormOpen(false)}
          onSaved={afterChange}
        />
      ) : null}
    </div>
  );
}

function toInput(c: SupplierContact) {
  return {
    fullName: c.fullName,
    jobTitle: c.jobTitle,
    contactType: c.contactType,
    phone: c.phone,
    whatsapp: c.whatsapp,
    email: c.email,
    preferredMethod: c.preferredMethod,
    isPrimary: c.isPrimary,
    isActive: c.isActive,
  };
}
