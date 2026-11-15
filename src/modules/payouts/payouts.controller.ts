import type { Request, Response } from 'express';

export async function getAccount(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./payouts.service');
  return ok(res, await svc.getAccount(req.user!.sub));
}

export async function createAccount(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./payouts.service');
  return ok(res, await svc.createAccount(req.user!.sub, req.body), 201);
}
