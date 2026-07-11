import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from 'class-validator';

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

  /** How to reach the database: 'postgres' (built-in TCP driver) or 'neon'. */
  @IsIn(['postgres', 'neon'])
  @IsOptional()
  DB_PROVIDER = 'postgres';

  @IsString()
  @IsOptional()
  WEB_ORIGIN?: string;

  @IsString()
  JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN = '12h';

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
