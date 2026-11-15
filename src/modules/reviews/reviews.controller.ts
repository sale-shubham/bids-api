import type { Request, Response } from 'express';
import { param } from '@/core/http/params';
import { resolvePaging, type ReviewListQuery } from './reviews.validation';

// POST /auctions/:id/review
export async function create(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./reviews.service');
  const review = await svc.createReview(req.user!.sub, param(req, 'id'), req.body);
  return ok(res, { review }, 201);
}

// POST /reviews/:id/reply
export async function reply(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./reviews.service');
  return ok(res, { review: await svc.replyToReview(req.user!.sub, param(req, 'id'), req.body.reply) });
}

// GET /members/:id/reviews
export async function listForSeller(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./reviews.service');
  const { items, meta } = await svc.listSellerReviews(param(req, 'id'), resolvePaging(req.query as unknown as ReviewListQuery));
  return paginated(res, items, meta);
}
