import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { BadRequest } from '@/core/errors/AppError';

// Handlers lazy-load the storage provider + response helper via dynamic import()
// so the S3/AWS SDK only initializes when an upload route is hit (cold start).

// Image folders a client may write to (S3 key prefix). Allowlisted so a client
// can't write to arbitrary prefixes. `uploads` = generic.
const ALLOWED_FOLDERS = new Set(['uploads', 'auctions', 'avatars']);

// Allowed image types → file extension for the presigned-upload flow.
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const router = Router();

router.use(authenticate, requireActiveMember);

// Presigned direct-to-S3 upload — the API mints a short-lived PUT URL and the
// browser uploads the bytes straight to S3, so no file bytes ever pass through
// the API. The client then PUTs the file to `presignedUrl` (Content-Type must
// equal `type`) and keeps `key`/`url`. `folder` selects the S3 prefix
// (allowlisted).
router.post(
  '/presign',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { storage } = await import('@/providers/storage');
    const type = String(req.body?.type ?? '');
    const ext = IMAGE_TYPES[type];
    if (!ext) throw BadRequest('Unsupported image type (JPEG/PNG/WebP only)');
    const folder = ALLOWED_FOLDERS.has(req.body?.folder) ? req.body.folder : 'uploads';

    const key = storage.keyFor(folder, ext);
    const presignedUrl = await storage.presignPut(key, type);
    return ok(res, { key, url: storage.url(key), presignedUrl }, 201);
  }),
);

export default router;
