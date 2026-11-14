import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import type { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// Fixed paths before /:id.
router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./notifications.service');
    const { items, meta } = await svc.listNotifications(req.user!.sub, req.query as unknown as { page: number; pageSize: number });
    return paginated(res, items, meta);
  }),
);

router.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./notifications.service');
    return ok(res, await svc.unreadCount(req.user!.sub));
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./notifications.service');
    return ok(res, await svc.markAllRead(req.user!.sub));
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./notifications.service');
    return ok(res, await svc.markRead(req.user!.sub, param(req, 'id')));
  }),
);

export default router;
