import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

// GET /auctions/:id/questions
export async function list(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./questions.service');
  const viewer = req.user ? { sub: req.user.sub, role: req.user.role } : undefined;
  return ok(res, await svc.listQuestions(param(req, 'id'), viewer));
}

// POST /auctions/:id/questions
export async function ask(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./questions.service');
  return ok(res, { question: await svc.askQuestion(req.user!.sub, param(req, 'id'), req.body.question) }, 201);
}

// POST /questions/:id/answer
export async function answer(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./questions.service');
  return ok(res, { question: await svc.answerQuestion(req.user!.sub, param(req, 'id'), req.body.answer) });
}

// POST /questions/:id/hide
export async function hide(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./questions.service');
  return ok(res, await svc.hideQuestion({ sub: req.user!.sub, role: req.user!.role }, param(req, 'id')));
}
