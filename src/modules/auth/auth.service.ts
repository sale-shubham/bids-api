import { prisma } from '@/core/prisma/client';
import { AppError, Unauthorized } from '@/core/errors/AppError';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './token.service';
import { upsertDeviceSession, touchSession, type DeviceMeta } from './session.service';

// TODO(Phase 1): email + password signup/login (bcryptjs), email-OTP verify at
// signup, and forgot-password live here. See otp-challenge.service.ts for the
// OTP mechanics. Each login must call issueSession() below.

export async function issueSession(
  member: Parameters<typeof signAccessToken>[0],
  deviceId: string,
  meta: DeviceMeta,
) {
  const session = await upsertDeviceSession(member.id, member.role, deviceId, meta);
  const accessToken = signAccessToken(member, session.id);
  const { token: refreshToken, expiresAt: refreshExpiresAt } = signRefreshToken(member.id, session.id);
  return { accessToken, refreshToken, refreshExpiresAt };
}

// Deliberately does NOT reissue the refresh token — only the access token is
// rotated here. The refresh token/cookie keeps whatever expiry it was signed
// with at login (issueSession), a fixed absolute deadline instead of a
// sliding window that would otherwise renew indefinitely for as long as the
// user stays active. Once it naturally expires, verifyRefreshToken() throws
// and the user is forced to log in again — by design, not a bug.
export async function refresh(rawToken: string) {
  const { sub: memberId, sid } = verifyRefreshToken(rawToken);

  const session = await prisma.session.findUnique({ where: { id: sid } });
  if (!session || session.memberId !== memberId) throw Unauthorized('Session expired. Please log in again.');

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, role: true, isActive: true },
  });
  // ACCOUNT_SUSPENDED, not the generic 401 — same code as authenticate's
  // requireActiveMember, so the frontend's silent-refresh failure
  // also routes to the suspended screen instead of a bare "log in again".
  if (!member || !member.isActive)
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Contact admin support.');

  await touchSession(sid);
  const accessToken = signAccessToken(member, sid);
  return { accessToken };
}

// Deletes this device's Session row so its tokens stop working immediately
// (checked in `authenticate`/`refresh`), not just at natural JWT expiry.
export async function logout(sessionId: string | null) {
  if (sessionId) await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

export async function logoutAll(memberId: string) {
  await prisma.session.deleteMany({ where: { memberId } });
}
