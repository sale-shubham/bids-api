import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const { resolvePaging } = await import('@/modules/reviews/reviews.validation');
  const svc = await import('./admin-reviews.service');
  const { hidden, q } = req.query as { hidden?: boolean; q?: string };
  const { items, meta } = await svc.listReviews({
    hidden,
    q,
    ...resolvePaging(req.query as unknown as { page: number; limit?: number; pageSize?: number }),
  });
  return paginated(res, items, meta);
}

// PATCH /admin/reviews/:id { hidden } -> { review }
export async function setHidden(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-reviews.service');
  return ok(res, { review: await svc.setReviewHidden(param(req, 'id'), req.body.hidden) });
}
