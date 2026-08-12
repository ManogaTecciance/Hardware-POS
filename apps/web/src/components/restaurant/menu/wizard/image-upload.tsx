'use client';

import { AlertTriangle, ImagePlus, Link2, RefreshCw, Trash2, Upload } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import { uploadMenuItemImage } from '@/lib/restaurant/api';

/**
 * Restaurant Menu Wizard — image field.
 *
 * Two capture modes (Upload / URL), a preview once accepted, and Replace /
 * Remove affordances. Values persist to `MenuItem.imageUrl` (D41). Uploads go
 * through the standalone `POST /restaurant/menu-items/image` endpoint so the
 * wizard can capture a photo before Save; the endpoint hands back the stored
 * URL and the wizard writes that URL on Save.
 *
 * Accessibility:
 *   - Tabs are role=tablist / role=tab with aria-selected.
 *   - Dropzone has a keyboard-reachable Browse button (drag+drop is NOT the
 *     only path — brief §29).
 *   - Errors render as role="alert".
 *   - Reduced-motion suppresses the drag-over surface lift.
 */

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(',');
const MAX_BYTES = 5 * 1024 * 1024;

type Mode = 'upload' | 'url';

interface Props {
  session: Session;
  /** Current persisted or in-progress image URL. Empty string means "no image". */
  value: string;
  onChange: (nextUrl: string) => void;
}

export function ImageUpload({ session, value, onChange }: Props) {
  const [mode, setMode] = React.useState<Mode>('upload');
  const [dragOver, setDragOver] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [urlDraft, setUrlDraft] = React.useState(value);
  const [uploadedMeta, setUploadedMeta] = React.useState<{
    name: string;
    size: number;
  } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setUrlDraft(value);
  }, [value]);

  const handleFiles = React.useCallback(
    async (files: FileList | File[] | null) => {
      const file = files?.[0];
      if (!file) return;
      setError(null);
      if (!ACCEPTED_MIME_TYPES.includes(file.type as (typeof ACCEPTED_MIME_TYPES)[number])) {
        setError('Image must be JPG, PNG or WEBP.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setError('Image must be smaller than 5 MB.');
        return;
      }
      setUploading(true);
      try {
        const { imageUrl } = await uploadMenuItemImage(session, file);
        onChange(imageUrl);
        setUploadedMeta({ name: file.name, size: file.size });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [session, onChange],
  );

  const remove = () => {
    onChange('');
    setUploadedMeta(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const applyUrl = () => {
    setError(null);
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      remove();
      return;
    }
    try {
      // Reject non-http(s) schemes at the frontend; server also validates.
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('Enter a http(s) image URL.');
        return;
      }
    } catch {
      setError('That does not look like a valid URL.');
      return;
    }
    onChange(trimmed);
    setUploadedMeta(null); // URL is not a file
  };

  const hasImage = !!value;
  const displayName = uploadedMeta?.name ?? (hasImage ? deriveFilename(value) : null);
  const displaySize = uploadedMeta?.size;

  // ── Preview area ─────────────────────────────────────────────
  if (hasImage) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center">
          <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value}
              alt=""
              className="h-full w-full object-cover animate-in fade-in motion-reduce:animate-none"
              style={{ animationDuration: '160ms' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{displayName ?? 'Image'}</p>
            <p className="text-xs text-muted-foreground">
              {displaySize != null ? `${formatBytes(displaySize)} · ` : ''}
              Stored — used on POS and menu.
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80" title={value}>
              {value}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={remove}
              disabled={uploading}
            >
              Remove
            </Button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => {
            void handleFiles(e.target.files);
          }}
        />
        {error ? (
          <p className="flex items-center gap-1 text-xs text-danger" role="alert">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </p>
        ) : null}
      </div>
    );
  }

  // ── Capture area ─────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Image source" className="inline-flex gap-1 rounded-lg bg-muted p-1">
        <TabButton
          selected={mode === 'upload'}
          onClick={() => setMode('upload')}
          icon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          Upload
        </TabButton>
        <TabButton
          selected={mode === 'url'}
          onClick={() => setMode('url')}
          icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          Image URL
        </TabButton>
      </div>

      {mode === 'upload' ? (
        <div
          role="region"
          aria-label="Upload image"
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(e.dataTransfer?.files ?? null);
          }}
          className={`rounded-xl border border-dashed p-6 text-center transition-colors motion-reduce:transition-none ${
            dragOver
              ? 'border-primary bg-primary/8'
              : 'border-border bg-muted/30 hover:border-primary'
          }`}
        >
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/12 text-primary">
            <ImagePlus className="h-6 w-6" aria-hidden="true" />
          </div>
          <p className="mt-3 text-sm font-medium">
            {dragOver ? 'Drop image to upload' : 'Drag & drop an image here'}
          </p>
          <p className="text-xs text-muted-foreground">or</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-1"
            onClick={() => fileInputRef.current?.click()}
            isLoading={uploading}
          >
            Browse files
          </Button>
          <p className="mt-3 text-[11px] text-muted-foreground">
            JPG, PNG or WEBP · Max 5 MB · Recommended 1200 × 1200
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="sr-only"
            onChange={(e) => {
              void handleFiles(e.target.files);
            }}
          />
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-border bg-card p-3">
          <label htmlFor="menu-image-url" className="text-sm font-medium">
            Paste image URL
          </label>
          <div className="flex gap-2">
            <Input
              id="menu-image-url"
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://cdn.example.com/mix-kottu.webp"
              maxLength={2048}
            />
            <Button type="button" onClick={applyUrl} size="sm" disabled={!urlDraft.trim()}>
              Use URL
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Use a direct JPG, PNG or WEBP image URL from an approved source. A normal
            recipe page URL is not an image URL.
          </p>
        </div>
      )}

      {error ? (
        <p className="flex items-center gap-1 text-xs text-danger" role="alert">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </p>
      ) : null}
    </div>
  );
}

function TabButton({
  selected,
  onClick,
  icon,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors motion-reduce:transition-none ${
        selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function deriveFilename(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ?? null;
  } catch {
    return null;
  }
}
