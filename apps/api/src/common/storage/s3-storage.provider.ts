import { randomUUID } from 'crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';

import { IMAGE_EXT, ResolvedImage, StorageProvider, UploadedImage } from './storage-provider';
import { IMAGE_KEY_PREFIX, toObjectKey, toStoredPath } from './storage.util';

/**
 * Fraction of the signed-URL lifetime for which a redirect to it may be cached.
 * The `/uploads/...` redirect carries `Cache-Control: max-age = ttl * this`, kept
 * well under the signature's own lifetime so a cached redirect can never point at
 * an already-expired URL — while still letting repeat views reuse one signed URL.
 * (Without any caching the signature would differ per request, giving every
 * response a fresh cache key and defeating the object's own immutable caching.)
 * At a 300s TTL this yields a 100s redirect window.
 */
const REDIRECT_CACHE_FRACTION = 1 / 3;

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** Custom endpoint (e.g. http://localhost:4566 for LocalStack). Omit for real AWS. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Lifetime (seconds) of presigned GET URLs. Env: S3_SIGNED_URL_TTL_SECONDS. */
  signedUrlTtlSeconds: number;
  /** `Cache-Control: max-age` (seconds) stored on the object. Env: IMAGE_CACHE_MAX_AGE_SECONDS. */
  cacheMaxAgeSeconds: number;
}

/**
 * S3-compatible object storage (AWS S3, LocalStack, MinIO). Objects are keyed
 * `products/<uuid>.<ext>` and the bucket stays private: reads go out as
 * short-lived presigned URLs minted per request, never as public object URLs.
 */
export class S3StorageProvider implements StorageProvider {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Object-URL base used only to recognise rows written before keys were stored. */
  private readonly legacyBase: string;
  /** Lifetime of a minted presigned URL, and how long a redirect to it may be cached. */
  private readonly signedUrlTtlSeconds: number;
  private readonly redirectMaxAgeSeconds: number;
  /** `Cache-Control: max-age` stored on each uploaded object. */
  private readonly cacheMaxAgeSeconds: number;
  /** Kept only so a failure can say WHERE it was trying to write (D81). */
  private readonly endpoint?: string;
  private readonly region: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.region = config.region;
    this.signedUrlTtlSeconds = config.signedUrlTtlSeconds;
    this.redirectMaxAgeSeconds = Math.floor(config.signedUrlTtlSeconds * REDIRECT_CACHE_FRACTION);
    this.cacheMaxAgeSeconds = config.cacheMaxAgeSeconds;
    this.client = new S3Client({
      region: config.region,
      // Skip the SDK's default streaming checksums — S3 emulators (LocalStack,
      // MinIO) reset the connection on the aws-chunked trailer encoding.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.endpoint
        ? {
            endpoint: config.endpoint,
            // Custom endpoints (LocalStack/MinIO) don't resolve bucket subdomains.
            forcePathStyle: true,
          }
        : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
    this.legacyBase = config.endpoint
      ? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`
      : `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  }

  async saveImage(file: UploadedImage): Promise<string> {
    const ext = IMAGE_EXT[file.mimetype];
    if (!ext) {
      throw new BadRequestException('Unsupported image type (use PNG, JPEG, WebP, or GIF)');
    }
    const key = `${IMAGE_KEY_PREFIX}/${randomUUID()}${ext}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          // Keys are content-unique (UUID per upload), so the object never changes:
          // `immutable` lets the browser trust its cache for the full max-age.
          CacheControl: `public, max-age=${this.cacheMaxAgeSeconds}, immutable`,
        }),
      );
    } catch (err) {
      throw this.explain(err);
    }
    return toStoredPath(key);
  }

  /**
   * D81 — turn an SDK error into something the operator can act on.
   *
   * The raw message is "The specified bucket does not exist", which names
   * neither the bucket, nor the endpoint, nor the fact that this workspace is
   * pointed at S3 at all. It reached a PO trying to upload a logo on a laptop
   * whose `.env` had been copied from the deployment: the bucket was real, it
   * just lived somewhere that machine could not see. An hour went into a
   * message that could have said so.
   *
   * Deliberately a 500, not a 400: the upload was fine and the SERVER is
   * misconfigured. Reporting it as a bad request would send the operator off
   * to blame their image.
   */
  private explain(err: unknown): Error {
    const name = (err as { name?: string })?.name ?? '';
    const where = this.endpointLabel();
    if (name === 'NoSuchBucket') {
      return new InternalServerErrorException(
        `Upload storage is set to S3 but the bucket "${this.bucket}" does not exist ${where}. ` +
          'Create it, point S3_BUCKET at one that exists, or set STORAGE_PROVIDER=local in ' +
          "apps/api/.env to store uploads on the server's own disk.",
      );
    }
    if (name === 'CredentialsProviderError' || name === 'InvalidAccessKeyId') {
      return new InternalServerErrorException(
        `Upload storage is set to S3 but the credentials for ${where} were rejected. ` +
          'Check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, or set STORAGE_PROVIDER=local.',
      );
    }
    // Anything else — a refused connection to a LocalStack that is not
    // running, most often — still says where it was trying to go.
    const detail = err instanceof Error ? err.message : String(err);
    return new InternalServerErrorException(
      `Could not store the upload ${where}: ${detail}. ` +
        'Set STORAGE_PROVIDER=local in apps/api/.env to store uploads on disk instead.',
    );
  }

  private endpointLabel(): string {
    return this.endpoint ? `at ${this.endpoint}` : `in region ${this.region}`;
  }

  async remove(storedPath: string | null | undefined): Promise<void> {
    const key = toObjectKey(storedPath) ?? this.legacyKey(storedPath);
    if (!key) return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      /* already gone — ignore */
    }
  }

  async resolve(key: string): Promise<ResolvedImage> {
    // Signing is a local HMAC over the request description — no call to AWS.
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.signedUrlTtlSeconds },
    );
    return { kind: 'redirect', url, maxAgeSeconds: this.redirectMaxAgeSeconds };
  }

  /** Key behind an absolute object URL stored before this provider kept keys. */
  private legacyKey(storedPath: string | null | undefined): string | null {
    if (!storedPath || !storedPath.startsWith(`${this.legacyBase}/`)) return null;
    return storedPath.slice(this.legacyBase.length + 1);
  }
}
