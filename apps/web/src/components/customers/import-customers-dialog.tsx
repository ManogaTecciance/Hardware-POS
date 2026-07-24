'use client';

import { Download, FileUp, Loader2 } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Session } from '@/lib/auth';
import {
  commitCustomerImport,
  downloadCustomerTemplate,
  previewCustomerImport,
  type CustomerImportCommitSummary,
  type ParsedCustomerRow,
} from '@/lib/customers-api';
import { formatMoney } from '@/lib/utils';

type Phase = 'select' | 'review' | 'done';

/**
 * Bulk customer import from the QuickBooks Online Customer template. Two
 * phases with a review step in between: upload → review every parsed row →
 * commit. Nothing is created until "Import customers" is pressed.
 */
export function ImportCustomersDialog({
  session,
  open,
  onClose,
  onImported,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [phase, setPhase] = React.useState<Phase>('select');
  const [file, setFile] = React.useState<File | null>(null);
  const [rows, setRows] = React.useState<ParsedCustomerRow[]>([]);
  const [summary, setSummary] = React.useState<CustomerImportCommitSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fileInput = React.useRef<HTMLInputElement>(null);

  const reset = React.useCallback(() => {
    setPhase('select');
    setFile(null);
    setRows([]);
    setSummary(null);
    setBusy(false);
    setError(null);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const committable = rows.filter((r) => r.errors.length === 0);
  const creates = committable.filter((r) => r.matchStatus === 'create').length;
  const updates = committable.filter((r) => r.matchStatus === 'update').length;
  const errored = rows.length - committable.length;

  const handleDownloadTemplate = async () => {
    setError(null);
    try {
      await downloadCustomerTemplate(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download the template');
    }
  };

  const handlePreview = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await previewCustomerImport(session, file);
      setRows(parsed);
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file');
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (committable.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitCustomerImport(session, committable);
      setSummary(result);
      setPhase('done');
      if (result.created > 0 || result.updated > 0) onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const footer =
    phase === 'select' ? (
      <>
        <Button variant="outline" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={handlePreview} disabled={!file || busy} isLoading={busy}>
          Upload &amp; review
        </Button>
      </>
    ) : phase === 'review' ? (
      <>
        <Button variant="outline" onClick={reset} disabled={busy}>
          Back
        </Button>
        <Button onClick={handleCommit} disabled={committable.length === 0 || busy} isLoading={busy}>
          Import {committable.length} customer{committable.length === 1 ? '' : 's'}
        </Button>
      </>
    ) : (
      <Button onClick={handleClose}>Done</Button>
    );

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      className={phase === 'review' ? 'sm:max-w-5xl' : 'sm:max-w-lg'}
      title="Import customers"
      description={
        phase === 'select'
          ? 'Upload a QuickBooks customer spreadsheet (.xlsx or .csv).'
          : phase === 'review'
            ? 'Review the customers before importing them.'
            : 'Import complete.'
      }
      footer={footer}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      {phase === 'select' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
            <div className="text-sm">
              <div className="font-medium">Need the template?</div>
              <div className="text-xs text-muted-foreground">
                The same columns as QuickBooks&apos; own customer import file.
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
              <Download className="h-4 w-4" />
              Template
            </Button>
          </div>

          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/30 p-8 text-center transition-colors hover:bg-muted"
          >
            <FileUp className="h-8 w-8 text-muted-foreground" />
            <span className="text-sm font-medium">{file ? file.name : 'Choose a spreadsheet'}</span>
            <span className="text-xs text-muted-foreground">.xlsx or .csv · max 10 MB</span>
          </button>

          <p className="text-xs text-muted-foreground">
            Existing customers are matched by name and updated. Imported customers default to the
            Retail POS type with credit off — adjust individual customers afterwards if needed.
            Legacy .xls files must be re-saved as .xlsx first.
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      ) : null}

      {phase === 'review' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="success">{creates} to create</Badge>
            <Badge variant="primary">{updates} to update</Badge>
            {errored > 0 ? <Badge variant="danger">{errored} with errors (excluded)</Badge> : null}
          </div>

          <div className="max-h-[52vh] overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Email / phone</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 text-right font-medium">Opening balance</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const hasError = r.errors.length > 0;
                  const location = [r.city, r.state, r.country].filter(Boolean).join(', ') || '—';
                  return (
                    <tr
                      key={r.rowNumber}
                      className={`border-t border-border ${hasError ? 'bg-danger-soft/30' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        {hasError ? (
                          <div className="mt-0.5 text-xs text-danger">{r.errors.join('; ')}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.company ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.qbCustomerType ?? '—'}</td>
                      <td className="px-3 py-2">
                        <div>{r.email ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{r.phone ?? ''}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{location}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.openingBalance != null ? formatMoney(r.openingBalance) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {hasError ? (
                          <Badge variant="danger">Error</Badge>
                        ) : r.matchStatus === 'update' ? (
                          <Badge variant="primary">Update</Badge>
                        ) : (
                          <Badge variant="success">Create</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Importing customers…
            </p>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      ) : null}

      {phase === 'done' && summary ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <ResultTile label="Created" value={summary.created} tone="success" />
            <ResultTile label="Updated" value={summary.updated} tone="primary" />
            <ResultTile
              label="Failed"
              value={summary.failed}
              tone={summary.failed > 0 ? 'danger' : 'neutral'}
            />
          </div>
          {summary.results.some((r) => r.outcome === 'failed') ? (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-danger/30 bg-danger-soft/40 p-3 text-xs text-danger">
              {summary.results
                .filter((r) => r.outcome === 'failed')
                .map((r) => (
                  <div key={r.rowNumber}>
                    Row {r.rowNumber}: {r.error}
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function ResultTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'primary' | 'neutral' | 'danger';
}) {
  const toneClass = {
    success: 'text-success',
    primary: 'text-primary',
    neutral: 'text-foreground',
    danger: 'text-danger',
  }[tone];
  return (
    <div className="rounded-xl border border-border p-3 text-center">
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
