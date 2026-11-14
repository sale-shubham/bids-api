import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { validate } from '@/core/middleware/validate';
import { contactLimiter } from '@/core/middleware/rateLimit';
import { contactSchema } from './contact.validation';

// Mounted at /contact — public, 5 per hour per IP.
const router = Router();

router.post(
  '/',
  contactLimiter,
  validate(contactSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./contact.service');
    return ok(res, await svc.sendContactMessage(req.body));
  }),
);

export default router;
