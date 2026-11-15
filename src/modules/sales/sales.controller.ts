import type { Request, Response } from 'express';
import { param } from '@/core/http/params';
import { pageSizeOf, type SaleListQuery } from './sales.validation';
import type { SaleStatus } from './sales.rules';

const viewer = (req: Request) => ({ id: req.user!.sub, role: req.user!.role });

export async function mine(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  const q = req.query as unknown as SaleListQuery & { role: 'buyer' | 'seller'; status?: SaleStatus };
  const { items, meta } = await svc.listMine(req.user!.sub, { role: q.role, status: q.status, page: q.page, pageSize: pageSizeOf(q) });
  return paginated(res, items, meta);
}

export async function getOne(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  return ok(res, await svc.getSaleDTO(param(req, 'id'), viewer(req)));
}

export async function checkout(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  return ok(res, await svc.checkout(req.user!.sub, param(req, 'id')));
}

export async function ship(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  return ok(res, await svc.shipSale(req.user!.sub, param(req, 'id'), req.body));
}

export async function confirm(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  return ok(res, await svc.confirmSale(req.user!.sub, param(req, 'id')));
}

export async function dispute(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./sales.service');
  return ok(res, await svc.disputeSale(req.user!.sub, param(req, 'id'), req.body.reason));
}

// POST /sales/:id/second-chance -> { offer }
export async function secondChance(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('@/modules/second-chance/second-chance.service');
  return ok(res, await svc.createOffer(req.user!.sub, param(req, 'id')), 201);
}
