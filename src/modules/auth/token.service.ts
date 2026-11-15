import jwt from 'jsonwebtoken';
import ms, { type StringValue } from 'ms';
import { env } from '@/core/config/env';
import { AppError, Unauthorized } from '@/core/errors/AppError';
import type { AuthUser } from '@/core/middleware/auth';
import type { Member } from '@prisma/client';

const ACCESS_TOKEN_EXPIRES_IN = (process.env.ACCESS_TOKEN_EXPIRES_IN?.trim() ||
  '15m') as StringValue;

const REFRESH_TOKEN_EXPIRES_IN = (process.env.REFRESH_TOKEN_EXPIRES_IN?.trim() ||
  '30d') as StringValue;

// Derived from the SAME env-configured strings the tokens are signed with, via
// the same `ms` package jsonwebtoken uses internally for `expiresIn` — these
// used to be hardcoded (15 min / 30 days) regardless of
// ACCESS_TOKEN_EXPIRES_IN / REFRESH_TOKEN_EXPIRES_IN, so e.g. setting
// ACCESS_TOKEN_EXPIRES_IN=1m shortened the JWT but left the browser cookie's
// maxAge at 15 minutes — the cookie outlived the token it carried. `ms()`
// returns undefined (not a throw) on an unparsable string, hence the `??`.
export const ACCESS_TTL_MS = ms(ACCESS_TOKEN_EXPIRES_IN) ?? 15 * 60 * 1000;
export const REFRESH_TTL_MS = ms(REFRESH_TOKEN_EXPIRES_IN) ?? 30 * 24 * 60 * 60 * 1000;

export function signAccessToken(member: Pick<Member, 'id' | 'role'>, sessionId: string) {
  const payload: AuthUser = {
    sub: member.id,
    role: member.role,
    sid: sessionId,
  };
  return jwt.sign(payload, env.jwt.accessSecret, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

export function signRefreshToken(
  memberId: string,
  sessionId: string
): {
  token: string;
  expiresAt: Date;
} {
  // Token itself isn't stored — the `sid` claim ties it to a Session row
  // (src/modules/auth/session.service.ts). Deleting that row revokes this
  // token immediately (checked in `authenticate` and `refresh`), even though
  // the JWT signature stays valid until natural expiry.
  const token = jwt.sign({ sub: memberId, sid: sessionId }, env.jwt.refreshSecret, {
    algorithm: 'HS256',
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  return { token, expiresAt };
}

export function verifyRefreshToken(token: string): { sub: string; sid: string } {
  try {
    const payload = jwt.verify(token, env.jwt.refreshSecret, {
      algorithms: ['HS256'],
    }) as { sub: string; sid: string };
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    throw Unauthorized('Invalid refresh token');
  }
}

const CHALLENGE_TTL = '5m' as StringValue;

export interface TwoFactorChallenge {
  sub: string;
  deviceInfo?: Record<string, unknown>;
}

// Short-lived proof that the password step passed; only /auth/2fa/verify accepts it.
export function signTwoFactorChallenge(memberId: string, deviceInfo?: Record<string, unknown>): string {
  return jwt.sign({ typ: '2fa', sub: memberId, ...(deviceInfo ? { di: deviceInfo } : {}) }, env.jwt.accessSecret, {
    algorithm: 'HS256',
    expiresIn: CHALLENGE_TTL,
  });
}

export function verifyTwoFactorChallenge(token: string): TwoFactorChallenge {
  try {
    const p = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] }) as {
      typ?: string;
      sub?: string;
      di?: Record<string, unknown>;
    };
    if (p.typ !== '2fa' || !p.sub) throw new Error('not a 2fa challenge');
    return { sub: p.sub, deviceInfo: p.di };
  } catch {
    throw new AppError(401, 'TWO_FACTOR_CHALLENGE_INVALID', 'Sign-in expired. Please log in again.');
  }
}
