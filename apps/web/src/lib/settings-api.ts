/**
 * Settings API client — reads/writes the persisted per-tenant settings, uploads
 * document branding assets (logo / signature / stamp), and renders A4 template
 * previews with sample data. Mirrors the backend `AppSettings` shape.
 */
import { api, authorizedFetch } from './api';
import type { Session } from './session-store';

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export type PaperSize = 'A4' | 'THERMAL_80';
export type Orientation = 'PORTRAIT' | 'LANDSCAPE';
export type BillFormat = 'A4' | 'THERMAL' | 'BOTH';
export type LogoAlignment = 'LEFT' | 'CENTER' | 'RIGHT';
export type LogoSize = 'SMALL' | 'MEDIUM' | 'LARGE';
export type MarginStyle = 'COMPACT' | 'STANDARD' | 'SPACIOUS';
export type PreviewDocumentType = 'quotation' | 'invoice' | 'return' | 'exchange';
export type BrandingAsset = 'logo' | 'signature' | 'stamp';

export interface DocumentSettings {
  companyName: string | null;
  addressLine: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  logoUrl: string | null;
  signatureUrl: string | null;
  stampUrl: string | null;
  footerText: string;
  billNote: string;
  accentColor: string;
  logoAlignment: LogoAlignment;
  logoSize: LogoSize;
  marginStyle: MarginStyle;
  defaultPaperSize: PaperSize;
  orientation: Orientation;
  showProductImages: boolean;
  showSku: boolean;
  showTaxColumn: boolean;
  showDiscountColumn: boolean;
  showCustomerTaxNumber: boolean;
  showPageNumbers: boolean;
  defaultBillFormat: BillFormat;
  signatureFields: boolean;
}

export interface AppSettings {
  currency: string;
  /**
   * Shop IANA timezone. Datetimes are stored in UTC everywhere; this is the zone
   * printed DOCUMENTS state their dates in, so an invoice reads the same for
   * everyone. On-screen datetimes use the viewer's own browser timezone.
   */
  timezone: string;
  taxRatePercent: number;
  taxInclusive: boolean;
  highDiscountThresholdPercent: number;
  receiptFooter: string;
  returns: Record<string, unknown>;
  quotation: Record<string, unknown>;
  documents: DocumentSettings;
  sharing: Record<string, unknown>;
}

/** A partial settings update; only the groups/fields present are changed. */
export interface UpdateSettingsInput {
  currency?: string;
  timezone?: string;
  taxRatePercent?: number;
  taxInclusive?: boolean;
  highDiscountThresholdPercent?: number;
  receiptFooter?: string;
  documents?: Partial<DocumentSettings>;
}

export function fetchSettings(session: Session): Promise<AppSettings> {
  return api.get<AppSettings>('/settings', auth(session));
}

export function updateSettings(session: Session, input: UpdateSettingsInput): Promise<AppSettings> {
  return api.put<AppSettings>('/settings', input, auth(session));
}

export function resetSettings(session: Session): Promise<AppSettings> {
  return api.post<AppSettings>('/settings/reset', undefined, auth(session));
}

/** Upload a branding image (multipart). Returns the updated settings. */
export async function uploadDocumentAsset(
  session: Session,
  asset: BrandingAsset,
  file: File,
): Promise<AppSettings> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch(`/settings/document-profile/${asset}`, session, {
    method: 'POST',
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.message ?? (res.status === 413 ? 'Image is too large (max 5MB)' : 'Upload failed');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return (json?.data ?? json) as AppSettings;
}

export function removeDocumentAsset(session: Session, asset: BrandingAsset): Promise<AppSettings> {
  return api.del<AppSettings>(`/settings/document-profile/${asset}`, auth(session));
}

/**
 * Render an A4 preview with sample data. `documents` carries UNSAVED settings so
 * the admin can preview edits before saving; `lineCount` demonstrates multi-page.
 */
export async function previewDocument(
  session: Session,
  type: PreviewDocumentType,
  documents?: Partial<DocumentSettings>,
  lineCount?: number,
): Promise<string> {
  const res = await api.post<{ html: string; format: 'A4' }>(
    `/documents/preview/${type}`,
    { documents, lineCount },
    auth(session),
  );
  return res.html;
}
