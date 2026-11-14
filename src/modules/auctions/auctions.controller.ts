import type { Request, Response } from 'express';
import { param } from '@/core/http/params';
import type { ListQuery, MineQuery } from './auctions.validation';

const serverTime = () => new Date().toISOString();
const actor = (req: Request) => ({ sub: req.user!.sub, role: req.user!.role });

// GET /auctions — `serverTime` is a top-level sibling of `data` / `meta`.
export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  const { items, meta } = await svc.listAuctions(req.query as unknown as ListQuery);
  return paginated(res, items, meta, { serverTime: serverTime() });
}

export async function home(_req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  return ok(res, { ...(await svc.homeFeed()), serverTime: serverTime() });
}

export async function categories(_req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  return ok(res, { categories: await svc.categoriesWithCounts() });
}

export async function mine(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  const { items, meta } = await svc.listMine(req.user!.sub, req.query as unknown as MineQuery);
  return paginated(res, items, meta, { serverTime: serverTime() });
}

export async function detail(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  const auction = await svc.getAuction(param(req, 'id'), req.user ? actor(req) : undefined);
  return ok(res, { auction, serverTime: serverTime() });
}

export async function create(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  const auction = await svc.createAuction(req.user!.sub, req.body);
  return ok(res, { auction }, 201);
}

export async function update(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  return ok(res, { auction: await svc.updateAuction(param(req, 'id'), actor(req), req.body) });
}

export async function remove(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  return ok(res, await svc.deleteAuction(param(req, 'id'), actor(req)));
}

export async function republish(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  return ok(res, { auction: await svc.republishAuction(param(req, 'id'), actor(req), req.body) });
}
