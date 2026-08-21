/**
 * D81 — an S3 failure has to say what to do about it.
 *
 * The raw SDK message is "The specified bucket does not exist": it names
 * neither the bucket, nor the endpoint, nor the fact that this deployment is
 * pointed at S3 at all. It cost a PO an hour on a laptop whose `.env` had
 * been copied from the deployment — the bucket was real, it just lived
 * somewhere that machine could not reach.
 *
 * Every case here asserts the message carries the three things a person needs
 * to act: WHICH bucket, WHERE it was looked for, and the one env change that
 * makes uploads work locally. Asserting merely that "an error was thrown"
 * would pass against the unhelpful message this replaces.
 */
import { InternalServerErrorException } from '@nestjs/common';

import { S3StorageProvider, type S3StorageConfig } from './s3-storage.provider';
import type { UploadedImage } from './storage-provider';

const CONFIG: S3StorageConfig = {
  bucket: 'hardware-pos-uploads',
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:4566',
  signedUrlTtlSeconds: 300,
  cacheMaxAgeSeconds: 3600,
};

const IMAGE: UploadedImage = {
  buffer: Buffer.from('x'),
  mimetype: 'image/webp',
} as UploadedImage;

/** Replace the provider's client with one that fails the way S3 does. */
function providerThatFailsWith(error: Error, config = CONFIG): S3StorageProvider {
  const provider = new S3StorageProvider(config);
  (provider as unknown as { client: { send: () => Promise<never> } }).client = {
    send: () => Promise.reject(error),
  };
  return provider;
}

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('S3StorageProvider — failures explain themselves', () => {
  it('names the bucket, the endpoint and the way out, for a missing bucket', async () => {
    const provider = providerThatFailsWith(
      named('NoSuchBucket', 'The specified bucket does not exist'),
    );

    await expect(provider.saveImage(IMAGE)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    const message = await provider.saveImage(IMAGE).catch((e: Error) => e.message);

    // WHICH bucket — absent from the SDK's own message.
    expect(message).toContain('hardware-pos-uploads');
    // WHERE it was looked for: a bucket that exists in AWS but not in the
    // LocalStack this machine is pointed at is the whole confusion.
    expect(message).toContain('http://127.0.0.1:4566');
    // And the one line that makes uploads work on a laptop.
    expect(message).toContain('STORAGE_PROVIDER=local');
  });

  it('reports a 500, not a 400 — the upload was fine, the server is not', async () => {
    const provider = providerThatFailsWith(named('NoSuchBucket', 'nope'));
    const err = (await provider.saveImage(IMAGE).catch((e: unknown) => e)) as {
      getStatus?: () => number;
    };
    /*
     * A 400 would send the operator off to blame their image file. The
     * request was valid; the deployment is misconfigured.
     */
    expect(err.getStatus?.()).toBe(500);
  });

  it('distinguishes rejected credentials from a missing bucket', async () => {
    const provider = providerThatFailsWith(named('InvalidAccessKeyId', 'bad key'));
    const message = await provider.saveImage(IMAGE).catch((e: Error) => e.message);
    expect(message).toContain('credentials');
    expect(message).toContain('S3_ACCESS_KEY_ID');
    // NEGATIVE — and does not send them hunting for a bucket that is fine.
    expect(message).not.toContain('does not exist');
  });

  it('still says where it was going for an unrecognised failure', async () => {
    // The commonest one in practice: LocalStack simply is not running.
    const provider = providerThatFailsWith(named('ECONNREFUSED', 'connect ECONNREFUSED'));
    const message = await provider.saveImage(IMAGE).catch((e: Error) => e.message);
    expect(message).toContain('http://127.0.0.1:4566');
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('STORAGE_PROVIDER=local');
  });

  it('names the region when there is no custom endpoint (real AWS)', async () => {
    const { endpoint: _dropped, ...noEndpoint } = CONFIG;
    const provider = providerThatFailsWith(named('NoSuchBucket', 'nope'), noEndpoint);
    const message = await provider.saveImage(IMAGE).catch((e: Error) => e.message);
    expect(message).toContain('us-east-1');
  });

  it('leaves an unsupported image type as a 400 — that IS the caller’s fault', async () => {
    const provider = providerThatFailsWith(named('NoSuchBucket', 'nope'));
    const err = (await provider
      .saveImage({ ...IMAGE, mimetype: 'application/pdf' })
      .catch((e: unknown) => e)) as { getStatus?: () => number };
    expect(err.getStatus?.()).toBe(400);
  });
});
