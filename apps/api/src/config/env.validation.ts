import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from 'class-validator';

import {
  IMAGE_CACHE_MAX_AGE_DEFAULT_SECONDS,
  IMAGE_MAX_EDGE_DEFAULT,
  IMAGE_WEBP_QUALITY_DEFAULT,
  SIGNED_URL_TTL_DEFAULT_SECONDS,
} from '../common/storage/storage.util';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Typed, validated view of process.env. Wired into ConfigModule via `validate`
 * so the app fails fast on boot if required configuration is missing.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  @IsOptional()
  API_PORT = 4000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  @IsOptional()
  WEB_ORIGIN?: string;

  @IsString()
  JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN = '12h';

  /** Days a refresh token stays valid (rotated on every use). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  REFRESH_TOKEN_TTL_DAYS = 30;

  // ── Upload storage ──
  /** Where uploaded files live: 'local' (API server disk) or 's3' (AWS/LocalStack). */
  @IsIn(['local', 's3'])
  @IsOptional()
  STORAGE_PROVIDER = 'local';

  @IsString()
  @IsOptional()
  S3_BUCKET?: string;

  @IsString()
  @IsOptional()
  S3_REGION?: string;

  /** Custom S3 endpoint (e.g. http://localhost:4566 for LocalStack). Omit for AWS. */
  @IsString()
  @IsOptional()
  S3_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  S3_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  S3_SECRET_ACCESS_KEY?: string;

  /** Lifetime (seconds) of presigned S3 GET URLs. AWS SigV4 caps this at 7 days. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(604_800)
  @IsOptional()
  S3_SIGNED_URL_TTL_SECONDS = SIGNED_URL_TTL_DEFAULT_SECONDS;

  // ── Upload image processing (applies to every stored image, both providers) ──
  /** Longest edge (px) every stored image is downscaled to before WebP encoding. */
  @Type(() => Number)
  @IsInt()
  @Min(16)
  @Max(8_192)
  @IsOptional()
  IMAGE_MAX_EDGE = IMAGE_MAX_EDGE_DEFAULT;

  /** WebP encoder quality (1-100) for stored images. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  IMAGE_WEBP_QUALITY = IMAGE_WEBP_QUALITY_DEFAULT;

  /** Browser cache lifetime (seconds) for served images (Cache-Control max-age). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(31_536_000)
  @IsOptional()
  IMAGE_CACHE_MAX_AGE_SECONDS = IMAGE_CACHE_MAX_AGE_DEFAULT_SECONDS;

  // ── Sync queue worker ──
  // The background worker drains SyncJob rows. Disable ('false') in tests or when
  // a BullMQ/Redis worker takes over.
  @IsString()
  @IsOptional()
  SYNC_WORKER_ENABLED = 'true';

  @Type(() => Number)
  @IsInt()
  @Min(250)
  @IsOptional()
  SYNC_WORKER_INTERVAL_MS = 5_000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  SYNC_WORKER_BATCH_SIZE = 10;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  SYNC_RETRY_BACKOFF_MS = 30_000;

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @IsOptional()
  SYNC_STALE_MS = 120_000;

  // ── QuickBooks Online OAuth 2.0 ──
  // Optional so the app boots without QBO configured; the endpoints validate
  // presence when a connection is initiated.
  @IsString()
  @IsOptional()
  QUICKBOOKS_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  QUICKBOOKS_CLIENT_SECRET?: string;

  @IsString()
  @IsOptional()
  QUICKBOOKS_REDIRECT_URI?: string;

  @IsString()
  @IsOptional()
  QUICKBOOKS_ENVIRONMENT = 'sandbox';

  /** Optional override for the QuickBooks Accounting API base (used in tests). */
  @IsString()
  @IsOptional()
  QUICKBOOKS_API_BASE?: string;

  /** Optional overrides for the Intuit OAuth endpoints (used in tests). */
  @IsString()
  @IsOptional()
  QUICKBOOKS_AUTHORIZE_URL?: string;

  @IsString()
  @IsOptional()
  QUICKBOOKS_TOKEN_URL?: string;

  @IsString()
  @IsOptional()
  QUICKBOOKS_REVOKE_URL?: string;

  /** Key used to encrypt OAuth tokens at rest (AES-256-GCM). Required for QBO. */
  @IsString()
  @IsOptional()
  TOKEN_ENCRYPTION_KEY?: string;

  // ── Documents / PDF (A4 quotations + bills) ──
  /**
   * Path to a Chrome/Chromium binary for server-side PDF generation. Leave unset
   * to use Puppeteer's bundled Chromium. If neither is available the app falls
   * back to serving print-ready A4 HTML.
   */
  @IsString()
  @IsOptional()
  PUPPETEER_EXECUTABLE_PATH?: string;

  /** Base URL used to build public quotation share links (…/public/quotations/:token). */
  @IsString()
  @IsOptional()
  PUBLIC_SHARE_BASE_URL?: string;

  // ── Email / sharing ──
  // `log` (default) records the message without sending — works with no creds.
  // `resend` needs RESEND_API_KEY + MAIL_FROM. `smtp` needs the SMTP_* vars.
  @IsIn(['log', 'resend', 'smtp'])
  @IsOptional()
  MAIL_PROVIDER = 'log';

  /** Default From header, e.g. "Hardware POS <quotes@yourdomain.com>". */
  @IsString()
  @IsOptional()
  MAIL_FROM?: string;

  @IsString()
  @IsOptional()
  RESEND_API_KEY?: string;

  @IsString()
  @IsOptional()
  SMTP_HOST?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  SMTP_PORT = 587;

  @IsString()
  @IsOptional()
  SMTP_SECURE = 'false';

  @IsString()
  @IsOptional()
  SMTP_USER?: string;

  @IsString()
  @IsOptional()
  SMTP_PASS?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${errors.toString()}`);
  }

  return validated;
}
