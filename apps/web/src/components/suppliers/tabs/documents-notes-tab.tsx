'use client';

import { Download, FileText, Pin, Plus, Upload } from 'lucide-react';
import * as React from 'react';

import { SupplierEmptyState, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Menu } from '@/components/ui/menu';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import { formatDate, formatFileSize } from '@/lib/suppliers/format';
import {
  addSupplierNote,
  deleteSupplierDocument,
  deleteSupplierNote,
  fetchSupplierDocuments,
  fetchSupplierNotes,
  updateSupplierNote,
  uploadSupplierDocument,
} from '@/lib/suppliers/suppliers-api';
import {
  DOCUMENT_TYPE_LABELS,
  type SupplierDocument,
  type SupplierDocumentType,
  type SupplierNote,
} from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

export function SupplierDocumentsNotesTab({
  session,
  supplierId,
  canManage,
}: {
  session: Session;
  supplierId: string;
  canManage: boolean;
}) {
  const [docs, setDocs] = React.useState<SupplierDocument[]>([]);
  const [notes, setNotes] = React.useState<SupplierNote[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [noteText, setNoteText] = React.useState('');
  const [savingNote, setSavingNote] = React.useState(false);

  const load = React.useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchSupplierDocuments(session, supplierId), fetchSupplierNotes(session, supplierId)])
      .then(([d, n]) => {
        if (cancelled) return;
        setDocs(d);
        setNotes(n);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load documents and notes.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, supplierId]);

  React.useEffect(() => load(), [load]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await addSupplierNote(session, supplierId, noteText.trim());
      setNoteText('');
      load();
    } finally {
      setSavingNote(false);
    }
  };
  const togglePin = async (n: SupplierNote) => {
    await updateSupplierNote(session, supplierId, n.id, { pinned: !n.pinned });
    load();
  };
  const removeNote = async (n: SupplierNote) => {
    await deleteSupplierNote(session, supplierId, n.id);
    load();
  };
  const removeDoc = async (d: SupplierDocument) => {
    await deleteSupplierDocument(session, supplierId, d.id);
    load();
  };

  if (loading) return <Card><div className="p-6 text-sm text-muted-foreground">Loading documents and notes…</div></Card>;
  if (error) return <Card><SupplierErrorState message={error} onRetry={load} /></Card>;

  const sortedNotes = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Documents</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)} leftIcon={<Upload className="h-4 w-4" />}>
              Upload
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {docs.length === 0 ? (
            <SupplierEmptyState icon={FileText} title="No documents yet" description="Upload agreements, quotations, price lists, or tax documents." />
          ) : (
            <ul className="divide-y divide-border">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <FileText className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{d.fileName}</div>
                    <div className="text-xs text-muted-foreground">
                      {DOCUMENT_TYPE_LABELS[d.docType]} · {formatFileSize(d.sizeBytes)} · {d.uploadedBy} · {formatDate(d.uploadedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <a
                      href={d.url ?? '#'}
                      onClick={(e) => !d.url && e.preventDefault()}
                      aria-disabled={!d.url}
                      className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted', !d.url && 'pointer-events-none opacity-40')}
                      aria-label={`Download ${d.fileName}`}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                    </a>
                    {canManage ? (
                      <Menu label={`Actions for ${d.fileName}`} items={[{ label: 'Delete', danger: true, onSelect: () => void removeDoc(d) }]} />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canManage ? (
            <div className="space-y-2">
              <Label htmlFor="new-note" className="sr-only">Add a note</Label>
              <Textarea id="new-note" value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={2} placeholder="Add an internal note…" />
              <div className="flex justify-end">
                <Button size="sm" onClick={addNote} isLoading={savingNote} disabled={!noteText.trim()} leftIcon={<Plus className="h-4 w-4" />}>
                  Add note
                </Button>
              </div>
            </div>
          ) : null}

          {sortedNotes.length === 0 ? (
            <SupplierEmptyState title="No notes yet" description="Notes are only visible to your team." />
          ) : (
            <ul className="space-y-2">
              {sortedNotes.map((n) => (
                <li key={n.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-foreground">{n.body}</p>
                    {canManage ? (
                      <Menu
                        label="Note actions"
                        items={[
                          { label: n.pinned ? 'Unpin' : 'Pin', onSelect: () => void togglePin(n) },
                          { label: 'Delete', danger: true, onSelect: () => void removeNote(n) },
                        ]}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {n.pinned ? <Badge variant="warning"><Pin className="h-3 w-3" aria-hidden /> Pinned</Badge> : null}
                    <span>{n.author}</span>
                    <span>·</span>
                    <span>{formatDate(n.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {uploadOpen ? (
        <UploadDialog session={session} supplierId={supplierId} onClose={() => setUploadOpen(false)} ondone={() => { setUploadOpen(false); load(); }} />
      ) : null}
    </div>
  );
}

function UploadDialog({
  session,
  supplierId,
  onClose,
  ondone,
}: {
  session: Session;
  supplierId: string;
  onClose: () => void;
  ondone: () => void;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [docType, setDocType] = React.useState<SupplierDocumentType>('AGREEMENT');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadSupplierDocument(session, supplierId, { name: file.name, size: file.size, docType });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the document.');
      setBusy(false);
    }
  };
  const onDone = () => ondone();

  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload document"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} isLoading={busy}>Upload</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="doc-type">Document type</Label>
          <Select id="doc-type" value={docType} onChange={(e) => setDocType(e.target.value as SupplierDocumentType)}>
            {(Object.keys(DOCUMENT_TYPE_LABELS) as SupplierDocumentType[]).map((t) => (
              <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-file">File</Label>
          <input
            id="doc-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:h-10 file:rounded-lg file:border-0 file:bg-muted file:px-4 file:text-sm file:font-medium file:text-foreground hover:file:bg-border"
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
