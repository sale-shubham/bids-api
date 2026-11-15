import type { Request, Response } from 'express';
import { NotFound } from '@/core/errors/AppError';
import { param } from '@/core/http/params';

// GET /members/me — profile plus this account's own device cap.
export async function me(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.getMemberDto(req.user!.sub);
  if (!member) throw NotFound('Member not found');
  return ok(res, { member });
}

// PATCH /members/me — self-service profile update.
export async function updateMe(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  await svc.updateProfile(req.user!.sub, req.body);
  const member = await svc.getMemberDto(req.user!.sub);
  return ok(res, { member });
}

// GET /members/:id/public — safe fields only.
export async function publicProfile(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.getPublicProfile(param(req, 'id'));
  if (!member) throw NotFound('Member not found');
  return ok(res, member);
}

// POST /members/me/phone/otp — { sentTo }
export async function sendPhoneOtp(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const phone = await import('./phone.service');
  return ok(res, await phone.sendPhoneOtp(req.body.phone));
}

// POST /members/me/phone/verify — { member }
export async function verifyPhone(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const phone = await import('./phone.service');
  const svc = await import('./members.service');
  await phone.verifyPhone(req.user!.sub, req.body.phone, req.body.code);
  return ok(res, { member: await svc.getMemberDto(req.user!.sub) });
}
