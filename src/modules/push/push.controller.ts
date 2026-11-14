import type { Request, Response } from 'express';

export async function vapidPublicKey(_req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./push.service');
  return ok(res, { publicKey: svc.vapidPublicKey() });
}

export async function subscribe(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./push.service');
  return ok(res, await svc.subscribe(req.user!.sub, req.user!.sid, req.body, req.headers['user-agent']), 201);
}

export async function unsubscribe(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./push.service');
  return ok(res, await svc.unsubscribe(req.user!.sub, req.body.endpoint));
}
