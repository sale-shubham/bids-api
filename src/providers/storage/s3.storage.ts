import crypto from 'node:crypto';
import { env } from '@/core/config/env';
import type { StorageProvider, StoredFile } from './storage.provider';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

// Uploads to S3; public URL served via CDN (CloudFront) when AWS_CLOUDFRONT_URL is set,
// otherwise the bucket's regional URL.
export class S3Storage implements StorageProvider {
  // The SDK is loaded on first use, not at module load: static imports of the
  // runtime-provided @aws-sdk/* packages are hoisted to the top of the Lambda
  // bundle, and the AWS clients together were ~30% of cold-start import time.
  private s3?: Promise<{
    sdk: typeof import('@aws-sdk/client-s3');
    client: import('@aws-sdk/client-s3').S3Client;
  }>;
  private sdk() {
    return (this.s3 ??= import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      client: new sdk.S3Client({ region: env.storage.s3.region }),
    })));
  }
  private async presign(
    command:
      import('@aws-sdk/client-s3').PutObjectCommand | import('@aws-sdk/client-s3').GetObjectCommand,
    expiresIn: number
  ) {
    const [{ client }, { getSignedUrl }] = await Promise.all([
      this.sdk(),
      import('@aws-sdk/s3-request-presigner'),
    ]);
    return getSignedUrl(client, command, { expiresIn });
  }
  private bucket = env.storage.s3.bucket;

  async save(buffer: Buffer, ext: string): Promise<StoredFile> {
    const safeExt = ext
      .replace(/[^a-z0-9.]/gi, '')
      .replace(/^\.?/, '.')
      .toLowerCase();
    const key = `uploads/${crypto.randomUUID()}${safeExt}`;
    const { sdk, client } = await this.sdk();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: MIME[safeExt] ?? 'application/octet-stream',
      })
    );
    return { key, url: this.url(key) };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const { sdk, client } = await this.sdk();
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    try {
      const { sdk, client } = await this.sdk();
      await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      /* already gone */
    }
  }

  url(key: string): string {
    const base =
      env.storage.cdnBaseUrl || `https://${this.bucket}.s3.${env.storage.s3.region}.amazonaws.com`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  keyFor(folder: string, ext: string): string {
    const safeExt = ext
      .replace(/[^a-z0-9.]/gi, '')
      .replace(/^\.?/, '.')
      .toLowerCase();
    const safeFolder = folder.replace(/^\/+|\/+$/g, '');
    return `${safeFolder}/${crypto.randomUUID()}-${Date.now()}${safeExt}`;
  }

  // ContentLength is signed into the URL, so S3 rejects a PUT whose body size
  // differs from the size the client declared at presign time.
  async presignPut(key: string, type: string, size: number, expiresIn = 60): Promise<string> {
    const { sdk } = await this.sdk();
    return this.presign(
      new sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: type, ContentLength: size }),
      expiresIn
    );
  }

  // Short-lived READ URL for private objects (private uploads such as ID documents).
  // Never use url() for those — it returns a permanent, unauthenticated link.
  async presignGet(key: string, expiresIn = 15 * 60): Promise<string> {
    const { sdk } = await this.sdk();
    return this.presign(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }), expiresIn);
  }

  // Reverses url() — strip whichever base it prepends (CDN or regional bucket
  // URL) to recover the raw key. Only URLs are ever persisted, never keys.
  keyFromUrl(url: string): string {
    const base =
      env.storage.cdnBaseUrl || `https://${this.bucket}.s3.${env.storage.s3.region}.amazonaws.com`;
    return url.replace(`${base.replace(/\/$/, '')}/`, '');
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const { sdk, client } = await this.sdk();
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
      await Promise.all(keys.map((k) => this.delete(k)));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
