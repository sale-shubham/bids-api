import type { Request, Response } from 'express';
import { param } from '@/core/http/params';
import type { ListBidsQuery, MyBidsQuery, PlaceBidInput } from './bids.validation';

export async function place(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./bids.service');
  const result = await svc.placeBid(req.user!.sub, param(req, 'id'), (req.body as PlaceBidInput).amountPaise);
  return ok(res, result, 201);
}

export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./bids.service');
  const viewer = req.user ? { sub: req.user.sub, role: req.user.role } : undefined;
  const { items, meta } = await svc.listBids(param(req, 'id'), req.query as unknown as ListBidsQuery, viewer);
  return paginated(res, items, meta);
}

export async function mine(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./bids.service');
  const { items, meta } = await svc.listMyBids(req.user!.sub, req.query as unknown as MyBidsQuery);
  return paginated(res, items, meta);
}
