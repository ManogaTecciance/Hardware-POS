'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { restaurantConfig } from '@/lib/restaurant/api';
import type { RestaurantBranchConfigView } from '@/lib/restaurant/types';

const CHANNELS: { key: string; label: string; hint: string }[] = [
  { key: 'DINE_IN', label: 'Dine in', hint: 'Table service' },
  { key: 'TAKEAWAY', label: 'Takeaway', hint: 'Counter and collection' },
  { key: 'ONLINE', label: 'Delivery', hint: 'Rider and partner orders' },
];

/**
 * D84 — the service charge, where the owner can actually set it.
 *
 * The charge has been computed correctly since D52 and printed on the bill
 * since D72; what was missing was any way to enter a number. It sat at the
 * schema default of 0.00, so every bill showed no service charge and there
 * was nothing an owner could do about it short of a database edit.
 *
 * Per BRANCH, not per tenant, because that is where the column lives and
 * because a group can price its rooms differently. The channel toggles are
 * here rather than assumed: "10% on dine-in only" and "10% on everything"
 * are both ordinary, and guessing either one puts money on a bill that
 * should not carry it.
 */
export function ChargesTab({ session, branchId }: { session: Session; branchId: string }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.RESTAURANT_CONFIG_MANAGE);

  const [config, setConfig] = React.useState<RestaurantBranchConfigView | null>(null);
  const [percent, setPercent] = React.useState('');
  const [packaging, setPackaging] = React.useState('');
  const [channels, setChannels] = React.useState<string[]>([]);
  const [taxable, setTaxable] = React.useState(true);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const apply = React.useCallback((cfg: RestaurantBranchConfigView) => {
    setConfig(cfg);
    setPercent(cfg.serviceChargePercent);
    setPackaging(cfg.packagingChargeAmount);
    setChannels(cfg.serviceChargeChannels);
    setTaxable(cfg.serviceChargeTaxable);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    restaurantConfig
      .get(session, branchId)
      .then((cfg) => {
        if (cancelled) return;
        apply(cfg);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load branch charges');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId, apply]);

  const toggle = (key: string) =>
    setChannels((cur) => (cur.includes(key) ? cur.filter((c) => c !== key) : [...cur, key]));

  const save = async () => {
    if (!config || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await restaurantConfig.update(session, branchId, {
        serviceChargePercent: Number(percent) || 0,
        serviceChargeChannels: channels,
        serviceChargeTaxable: taxable,
        packagingChargeAmount: Number(packaging) || 0,
        // Optimistic concurrency: two managers editing one branch is rare,
        // but the row is versioned, so use it rather than clobber.
        expectedVersion: config.version,
      });
      apply(next);
      setMessage('Saved. New bills use these charges immediately.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (status === 'loading') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading charges…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error' || !config) {
    return (
      <Card className="max-w-3xl">
        <CardContent className="py-16 text-center text-sm text-danger">
          {error ?? 'Could not load branch charges.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Service charge</CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Applied to the bill for the channels picked below. Set per branch.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Service charge</span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                inputMode="decimal"
                value={percent}
                disabled={!canManage}
                onChange={(e) => setPercent(e.target.value)}
                aria-label="Service charge percent"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <span className="mt-1 block text-xs text-muted-foreground">
              A common figure is 10%. Zero removes the line from the bill entirely.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Packaging charge</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={packaging}
              disabled={!canManage}
              onChange={(e) => setPackaging(e.target.value)}
              aria-label="Packaging charge amount"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              A flat amount per takeaway or delivery order. Dine-in never carries it.
            </span>
          </label>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Charge it on</p>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => {
              const on = channels.includes(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  disabled={!canManage}
                  onClick={() => toggle(c.key)}
                  aria-pressed={on}
                  title={c.hint}
                  className={`inline-flex h-11 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card hover:border-primary'
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {channels.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              No channels selected — no bill will carry a service charge.
            </p>
          ) : null}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={taxable}
            disabled={!canManage}
            onChange={(e) => setTaxable(e.target.checked)}
          />
          <span>
            Tax applies to the service charge
            <span className="block text-xs text-muted-foreground">
              When on, tax is calculated on the subtotal plus the service charge. Turn it off
              where the charge sits outside the taxable base.
            </span>
          </span>
        </label>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? <p className="text-sm text-success">{message}</p> : null}

        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button isLoading={saving} disabled={!canManage} onClick={() => void save()}>
            Save charges
          </Button>
          {!canManage ? (
            <span className="text-xs text-muted-foreground">
              Your role can view these but not change them.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
