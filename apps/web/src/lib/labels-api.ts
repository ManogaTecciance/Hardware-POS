import { api } from './api';
import type { Session } from './auth';

export type RollKey = 'plain' | 'double' | 'triple';

export interface RollProfile {
  key: RollKey;
  label: string;
  columns: number;
  stickerWidthMm: number;
  stickerHeightMm: number;
  gapXMm: number;
  marginLeftMm: number;
  marginTopMm: number;
  offsetXMm: number;
  offsetYMm: number;
  barcodeHeightMm: number;
  content: {
    productName: boolean;
    price: boolean;
    sku: boolean;
    humanReadable: boolean;
  };
  webWidthMm: number;
}

export interface LabelLine {
  productId: string;
  copies: number;
}

export interface BuildZplRequest {
  roll: RollKey;
  lines: LabelLine[];
  dpi?: number;
  startOffset?: number;
  darkness?: number;
  qr?: boolean;
}

export interface BuildZplResult {
  zpl: string;
  stickerCount: number;
  rowCount: number;
  /** Products dropped because they carry no SKU to encode. */
  skipped: string[];
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export async function fetchRollProfiles(session: Session): Promise<RollProfile[]> {
  return api.get<RollProfile[]>('/labels/profiles', auth(session));
}

/**
 * Ask the API for the ZPL payload. The browser only relays it — label layout
 * lives server-side so a template fix ships without a client deploy.
 */
export async function buildLabelZpl(
  session: Session,
  request: BuildZplRequest,
): Promise<BuildZplResult> {
  return api.post<BuildZplResult>('/labels/zpl', request, auth(session));
}
