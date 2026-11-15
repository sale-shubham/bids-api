import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

export async function list(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./saved-searches.service');
  return ok(res, await svc.listSavedSearches(req.user!.sub));
}

export async function create(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./saved-searches.service');
  return ok(res, await svc.createSavedSearch(req.user!.sub, req.body), 201);
}

export async function remove(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./saved-searches.service');
  return ok(res, await svc.deleteSavedSearch(req.user!.sub, param(req, 'id')));
}
