'use client';

import * as React from 'react';
import { AlertTriangle, Cloud, CloudOff, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isModuleEnabled } from '@/lib/platform-api';
import { useEffectiveProfile } from '@/lib/platform-profile';

const POLL_INTERVAL_MS = 30_000;

interface SyncStatusSummary {
  pendingCount: number;
  failedCount: number;
  lastSyncedAt: string | null;
  quickbooksConnected: boolean;
}

type PillState = 'synced' | 'pending' | 'failed' | 'disconnected';

const CONFIG: Record<
  PillState,
  {
    label: (s: SyncStatusSummary) => string;
    variant: 'success' | 'warning' | 'danger' | 'neutral';
    Icon: typeof Cloud;
  }
> = {
  synced: { label: () => 'Synced', variant: 'success', Icon: Cloud },
  pending: { label: (s) => `Syncing ${s.pendingCount}`, variant: 'warning', Icon: RefreshCw },
  failed: { label: (s) => `${s.failedCount} sync failed`, variant: 'danger', Icon: AlertTriangle },
  disconnected: { label: () => 'QuickBooks off', variant: 'neutral', Icon: CloudOff },
};

function resolveState(s: SyncStatusSummary): PillState {
  if (s.failedCount > 0) return 'failed';
  if (s.pendingCount > 0) return 'pending';
  if (!s.quickbooksConnected) return 'disconnected';
  return 'synced';
}

/** Live queue/QuickBooks sync pill for the header — polls while the tab is visible. */
export function SyncStatus() {
  const { session } = useAuth();
  const { profile, status } = useEffectiveProfile();
  const [summary, setSummary] = React.useState<SyncStatusSummary | null>(null);

  const token = session?.token;
  const tenantId = session?.user.tenantId;

  /*
   * `/sync/status` is QuickBooks-only and module-enforced on the server, so for a
   * tenant without the QUICKBOOKS module every poll is a guaranteed 403 — twice a
   * minute, per open tab, for a pill that then renders nothing. The header is
   * chrome on every authenticated page, so this reached restaurant tenants on
   * every screen, not only the QuickBooks routes Slice 8.6 gated by path.
   *
   * Unresolved is its own state (D31): while the profile is loading, and after a
   * failed read, the pill neither polls nor renders. Assuming "probably
   * QuickBooks" is exactly what would put the 403 back on every slow network.
   */
  const quickbooksEnabled =
    status === 'ready' && profile !== null && isModuleEnabled(profile, 'QUICKBOOKS');

  React.useEffect(() => {
    if (!token || !tenantId || !quickbooksEnabled) return;
    let cancelled = false;

    const load = async () => {
      try {
        const s = await api.get<SyncStatusSummary>('/sync/status', { token, tenantId });
        if (!cancelled) setSummary(s);
      } catch {
        /* keep the last known state — the pill must never break the header */
      }
    };

    const loadIfVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };

    void load();
    const timer = window.setInterval(loadIfVisible, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', loadIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', loadIfVisible);
    };
  }, [token, tenantId, quickbooksEnabled]);

  // Both conditions matter: `quickbooksEnabled` suppresses a stale pill if the
  // profile stops resolving, `summary` covers the first load before it arrives.
  if (!quickbooksEnabled || !summary) return null;

  const state = resolveState(summary);
  const { label, variant, Icon } = CONFIG[state];
  return (
    <Badge variant={variant}>
      <Icon className="h-3.5 w-3.5" />
      {label(summary)}
    </Badge>
  );
}
