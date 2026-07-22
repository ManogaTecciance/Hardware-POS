'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { AlertTriangle, ArrowLeft, Info, Pencil } from 'lucide-react';

import {
  PreferredBadge,
  SupplierQuickBooksBadge,
  SupplierStatusBadge,
} from '@/components/suppliers/supplier-badges';
import { SupplierAvatar } from '@/components/suppliers/supplier-avatar';
import { DemoDataBanner, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { buildSupplierMenuItems } from '@/components/suppliers/supplier-menu-items';
import { useSupplierActionDialogs } from '@/components/suppliers/use-supplier-action-dialogs';
import { SupplierOverviewTab } from '@/components/suppliers/tabs/overview-tab';
import { SupplierContactsTab } from '@/components/suppliers/tabs/contacts-tab';
import { SupplierProductsTab } from '@/components/suppliers/tabs/products-tab';
import { SupplierPurchaseHistoryTab } from '@/components/suppliers/tabs/purchase-history-tab';
import { SupplierDocumentsNotesTab } from '@/components/suppliers/tabs/documents-notes-tab';
import { SupplierFinancialSummaryTab } from '@/components/suppliers/tabs/financial-summary-tab';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Menu } from '@/components/ui/menu';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { deriveSupplierAlerts, formatBalance, formatDate, type AlertSeverity } from '@/lib/suppliers/format';
import {
  fetchSupplier,
  fetchSupplierContacts,
  fetchSupplierProducts,
  isDemoData,
} from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

type TabKey = 'overview' | 'contacts' | 'products' | 'purchases' | 'documents' | 'financial';

export default function SupplierProfilePage() {
  const { session } = useAuth();
  const router = useRouter();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);
  const { supplierId } = useParams<{ supplierId: string }>();

  const [supplier, setSupplier] = React.useState<Supplier | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<TabKey>('overview');
  const [reloadKey, setReloadKey] = React.useState(0);

  const [hasPrimaryContact, setHasPrimaryContact] = React.useState(true);
  const [linkedProductCount, setLinkedProductCount] = React.useState(0);

  const { request, dialogs } = useSupplierActionDialogs(session, {
    onChanged: (updated) => {
      setSupplier(updated);
      setReloadKey((k) => k + 1);
    },
    onDeleted: () => router.push('/suppliers'),
  });

  React.useEffect(() => {
    if (!session || !access.canView || !supplierId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSupplier(session, supplierId)
      .then((s) => !cancelled && setSupplier(s))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load the supplier.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, access.canView, supplierId, reloadKey]);

  // Aggregates needed for contextual alerts.
  React.useEffect(() => {
    if (!session || !supplierId) return;
    let cancelled = false;
    fetchSupplierContacts(session, supplierId)
      .then((c) => !cancelled && setHasPrimaryContact(c.some((x) => x.isPrimary && x.isActive)))
      .catch(() => undefined);
    fetchSupplierProducts(session, supplierId)
      .then((p) => !cancelled && setLinkedProductCount(p.length))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, supplierId, reloadKey]);

  if (session && !access.canView) {
    return (
      <Card>
        <div className="p-10 text-center text-sm text-muted-foreground">You don’t have access to suppliers.</div>
      </Card>
    );
  }

  if (loading) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  if (error || !supplier || !session) {
    return (
      <div className="space-y-4">
        <Link href="/suppliers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to suppliers
        </Link>
        <Card>
          <SupplierErrorState message={error ?? 'Supplier not found'} onRetry={() => setReloadKey((k) => k + 1)} />
        </Card>
      </div>
    );
  }

  const alerts = deriveSupplierAlerts(supplier, { hasPrimaryContact, linkedProductCount });

  const runAlertAction = (action: ReturnType<typeof deriveSupplierAlerts>[number]['action']) => {
    switch (action) {
      case 'add-contact':
        setTab('contacts');
        break;
      case 'link-products':
        setTab('products');
        break;
      case 'view-financials':
        setTab('financial');
        break;
      case 'map-quickbooks':
      case 'retry-sync':
        void request('map-qb', supplier);
        break;
      case 'reactivate':
        void request('reactivate', supplier);
        break;
      case 'edit':
      case 'review-bank':
        router.push(`/suppliers/${supplier.id}/edit`);
        break;
    }
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'contacts', label: 'Contacts' },
    { key: 'products', label: 'Products supplied' },
    { key: 'purchases', label: 'Purchase history' },
    { key: 'documents', label: 'Documents & notes' },
    ...(access.canViewFinancials ? [{ key: 'financial' as const, label: 'Financial summary' }] : []),
  ];

  return (
    <div className="space-y-6">
      <Link href="/suppliers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to suppliers
      </Link>

      {isDemoData() ? <DemoDataBanner /> : null}

      {/* Profile header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <SupplierAvatar name={supplier.name} logoUrl={supplier.logoUrl} size="lg" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{supplier.name}</h1>
            <div className="mt-0.5 text-sm text-muted-foreground">{supplier.code}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <SupplierStatusBadge status={supplier.status} />
              <SupplierQuickBooksBadge status={supplier.quickbooks.status} />
              {supplier.isPreferred ? <PreferredBadge /> : null}
            </div>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Main contact:</dt>
                <dd className="font-medium">{supplier.mainContactName ?? '—'}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Outstanding:</dt>
                <dd className="font-medium tabular-nums">
                  {supplier.financials.available ? formatBalance(supplier.financials.outstandingBalance) : 'Not synced'}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {access.canManage ? (
            <Link href={`/suppliers/${supplier.id}/edit`} className={buttonVariants({ variant: 'outline' })}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          ) : null}
          <Menu
            label="More supplier actions"
            items={buildSupplierMenuItems(
              { id: supplier.id, name: supplier.name, status: supplier.status, qbStatus: supplier.quickbooks.status },
              access,
              (a, t) => void request(a, t),
            )}
          />
        </div>
      </div>

      {/* Blocked banner */}
      {supplier.status === 'BLOCKED' ? (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <strong>This supplier is blocked.</strong> {supplier.blockedReason ?? 'New purchasing is prevented.'}
          </span>
        </div>
      ) : null}

      {/* Alerts */}
      {alerts.length > 0 ? (
        <div className="space-y-2">
          {alerts.map((a) => (
            <AlertRow key={a.id} severity={a.severity} message={a.message} actionLabel={a.actionLabel} onAction={() => runAlertAction(a.action)} />
          ))}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="border-b border-border">
        <ChipRow activeKey={tab} ariaLabel="Supplier sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              data-active={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </ChipRow>
      </div>

      {/* Tab panels (lazy: only the active tab mounts and fetches) */}
      <div key={`${tab}-${reloadKey}`}>
        {tab === 'overview' ? (
          <SupplierOverviewTab session={session} supplier={supplier} onOpenTab={(t) => setTab(t as TabKey)} onMapQuickBooks={() => void request('map-qb', supplier)} />
        ) : null}
        {tab === 'contacts' ? (
          <SupplierContactsTab session={session} supplierId={supplier.id} canManage={access.canManage} onChanged={() => setReloadKey((k) => k + 1)} />
        ) : null}
        {tab === 'products' ? (
          <SupplierProductsTab session={session} supplierId={supplier.id} canManage={access.canManage} />
        ) : null}
        {tab === 'purchases' ? <SupplierPurchaseHistoryTab session={session} supplierId={supplier.id} /> : null}
        {tab === 'documents' ? (
          <SupplierDocumentsNotesTab session={session} supplierId={supplier.id} canManage={access.canManage} />
        ) : null}
        {tab === 'financial' ? (
          <SupplierFinancialSummaryTab supplier={supplier} canViewFinancials={access.canViewFinancials} onMapQuickBooks={() => void request('map-qb', supplier)} />
        ) : null}
      </div>

      {dialogs}
    </div>
  );
}

function AlertRow({
  severity,
  message,
  actionLabel,
  onAction,
}: {
  severity: AlertSeverity;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const styles: Record<AlertSeverity, string> = {
    info: 'border-info/30 bg-info-soft text-info',
    warning: 'border-warning/40 bg-warning-soft text-warning',
    danger: 'border-danger/40 bg-danger-soft text-danger',
  };
  const Icon = severity === 'info' ? Info : AlertTriangle;
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm', styles[severity])}>
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {message}
      </span>
      <button type="button" onClick={onAction} className="shrink-0 rounded-lg px-2 py-1 font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {actionLabel}
      </button>
    </div>
  );
}
