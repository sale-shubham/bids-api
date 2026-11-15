import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/core/config/env';
import { AppError, Forbidden, Unauthorized } from '@/core/errors/AppError';
import { prisma } from '@/core/prisma/client';
import type { Role } from '@prisma/client';

export interface AuthUser {
  sub: string; // Member id
  role: Role;
  sid: string; // Session row id — see src/modules/auth/session.service.ts
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const ACCESS_COOKIE = 'nb_at';
export const REFRESH_COOKIE = 'nb_rt';

// Checks the Session row on every call (not just the JWT signature) so a
// device evicted by the device cap (default 3, admin-configurable; src/modules/auth/session.service.ts)
// is rejected on its very next request, instead of staying valid until the
// access token's natural 15-min expiry.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    await loadAuthUser(req);
  } catch (err) {
    return next(err);
  }
  next();
}

// For public routes whose answer depends on who asks (e.g. auction detail shows
// "your bid"). No token, or a bad one, is not an error — the caller stays anonymous.
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    await loadAuthUser(req);
  } catch {
    req.user = undefined;
  }
  next();
}

// Sets req.user from the access token, or throws 401.
async function loadAuthUser(req: Request): Promise<void> {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  const token = bearer ?? req.cookies?.[ACCESS_COOKIE];
  if (!token) throw Unauthorized('Authentication required');

  let payload: AuthUser;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] }) as AuthUser;
  } catch {
    throw Unauthorized('Invalid or expired token');
  }

  const session = await prisma.session.findUnique({ where: { id: payload.sid } });
  if (!session || session.memberId !== payload.sub) {
    throw Unauthorized('Session expired. Please log in again.');
  }

  req.user = { sub: payload.sub, role: payload.role, sid: payload.sid };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw Unauthorized();
    if (!roles.includes(req.user.role)) throw Forbidden('Insufficient permissions');
    next();
  };
}

// Members must be active to use the platform. Read isActive live from the DB,
// not the (possibly stale) JWT claim, so a deactivation takes effect immediately.
export async function requireActiveMember(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw Unauthorized();
    if (req.user.role === 'SUPER_ADMIN') return next();
    const member = await prisma.member.findUnique({
      where: { id: req.user.sub },
      select: { isActive: true },
    });
    // ACCOUNT_SUSPENDED (not the generic FORBIDDEN code) so the frontend can
    // show a dedicated "contact admin" screen instead of a generic error toast.
    if (!member || !member.isActive)
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Contact admin support.');
    next();
  } catch (err) {
    next(err);
  }
}
