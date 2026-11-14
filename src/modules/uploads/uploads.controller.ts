import type { Request, Response } from 'express';
import { env } from '@/core/config/env';
import { ServiceUnavailable } from '@/core/errors/AppError';
import { IMAGE_TYPES } from './uploads.validation';

// POST /uploads/presign — mints a short-lived PUT URL; the browser uploads the
// bytes straight to S3 (Content-Type must equal `contentType` and the body exactly `size` bytes; both are signed). The object key
// is generated server-side. Lazy-loads the storage provider so the AWS SDK only
// initialises when this route is hit.
export async function presign(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  // Local dev without S3 configured: clear 503 rather than an AWS SDK crash.
  if (!env.storage.s3.bucket) throw ServiceUnavailable('File uploads are not configured on this server');
  const { storage } = await import('@/providers/storage');
  const { folder, contentType, size } = req.body as { folder: string; contentType: string; size: number };

  const key = storage.keyFor(folder, IMAGE_TYPES[contentType]);
  let uploadUrl: string;
  try {
    uploadUrl = await storage.presignPut(key, contentType, size);
  } catch {
    throw ServiceUnavailable('Could not prepare the upload. Please try again.');
  }
  return ok(res, { uploadUrl, key, url: storage.url(key) });
}
