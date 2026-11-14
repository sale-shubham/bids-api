import type { Request, Response } from 'express';
import { param } from '@/core/http/params';
import type { MineQuery } from './commissions.validation';

export async function mine(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./commissions.service');
  const { items, meta } = await svc.listMine(req.user!.sub, req.query as unknown as MineQuery);
  return paginated(res, items, meta);
}

export async function summary(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./commissions.service');
  return ok(res, await svc.summary(req.user!.sub));
}

export async function checkout(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./commissions.service');
  return ok(res, await svc.checkout(req.user!.sub, param(req, 'id')));
}
