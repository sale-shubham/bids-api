import bcrypt from 'bcryptjs';
import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { AppError, Unauthorized } from '@/core/errors/AppError';
import { emailProvider } from '@/providers/email';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './token.service';
import { upsertDeviceSession, touchSession, type DeviceMeta } from './session.service';
import { consumeOtpChallenge, issueOtpChallenge } from './otp-challenge.service';
import { memberProfileSelect } from '@/modules/members/member.select';

// Email + password auth (bcryptjs, cost 12). Email OTP is used only to verify
// the email at signup and for forgot-password (otp-challenge.service.ts).
// Every successful login/verify must call issueSession() below.

export const BCRYPT_COST = 12;

// Compared against when the email is unknown so a miss costs the same time as
// a wrong password (no timing-based account enumeration).
const DUMMY_HASH = '$2b$12$uiGRUT3o6a81UJTaAQfUuORQUrFPF2ift5g900TyYF9mc26MUARNS';

export const EmailTaken = () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
export const InvalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
export const EmailNotVerified = () =>
  new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email. We sent you a new code.');
export const AccountSuspended = () =>
  new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Contact admin support.');

const hash = (password: string) => bcrypt.hash(password, BCRYPT_COST);

export async function signup(input: { name: string; email: string; password: string; role: 'BIDDER' | 'AUCTIONEER' }) {
  const email = input.email;
  const existing = await prisma.member.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  if (existing?.emailVerifiedAt) throw EmailTaken();

  const passwordHash = await hash(input.password);
  if (existing) {
    // Unverified signup being retried: take the latest details.
    await prisma.member.update({
      where: { id: existing.id },
      data: { name: input.name, passwordHash, role: input.role },
    });
  } else {
    await prisma.member.create({
      data: { email, name: input.name, passwordHash, role: input.role, emailVerifiedAt: null },
    });
  }
  return issueOtpChallenge(email, 'SIGNUP', { onCooldown: 'skip' });
}

export async function verifySignup(email: string, code: string) {
  await consumeOtpChallenge(email, 'SIGNUP', code);
  const member = await prisma.member.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  if (!member) throw Unauthorized('OTP expired or not requested. Please request a new one.');
  const verified = await prisma.member.update({
    where: { id: member.id },
    data: { emailVerifiedAt: member.emailVerifiedAt ?? new Date() },
    select: { ...memberProfileSelect },
  });
  // Welcome email is best-effort — never fail a successful verification.
  emailProvider
    .send({
      to: email,
      subject: 'Welcome to NobleBid',
      template: 'welcome',
      data: { name: verified.name, role: verified.role },
    })
    .catch((err) => logger.warn({ err, to: email }, 'welcome email failed'));
  return verified;
}

export async function resendSignup(email: string) {
  const member = await prisma.member.findUnique({ where: { email }, select: { emailVerifiedAt: true } });
  // Unknown or already-verified: answer the same as success (no enumeration).
  if (!member || member.emailVerifiedAt) return { resendAfterSec: 30 };
  return issueOtpChallenge(email, 'SIGNUP');
}

export async function login(email: string, password: string) {
  const member = await prisma.member.findUnique({
    where: { email },
    select: { ...memberProfileSelect, passwordHash: true },
  });
  const valid = await bcrypt.compare(password, member?.passwordHash ?? DUMMY_HASH);
  if (!member || !valid) throw InvalidCredentials();
  if (!member.emailVerifiedAt) {
    await issueOtpChallenge(email, 'SIGNUP', { onCooldown: 'skip' }).catch((err) =>
      logger.warn({ err, to: email }, 'login: could not send verification code'),
    );
    throw EmailNotVerified();
  }
  if (!member.isActive) throw AccountSuspended();
  const { passwordHash: _omit, ...safe } = member;
  return safe;
}

export async function forgotPassword(email: string) {
  const member = await prisma.member.findUnique({ where: { email }, select: { id: true } });
  if (member) {
    // Swallow every failure: the response must not reveal whether the email exists.
    await issueOtpChallenge(email, 'PASSWORD_RESET', { onCooldown: 'skip' }).catch((err) =>
      logger.warn({ err, to: email }, 'forgot-password: could not send code'),
    );
  }
  return { resendAfterSec: 30 };
}

export async function resetPassword(email: string, code: string, password: string) {
  await consumeOtpChallenge(email, 'PASSWORD_RESET', code);
  const member = await prisma.member.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  if (!member) throw Unauthorized('OTP expired or not requested. Please request a new one.');
  const passwordHash = await hash(password);
  await prisma.$transaction([
    // Having received the reset code proves ownership of the email.
    prisma.member.update({
      where: { id: member.id },
      data: { passwordHash, emailVerifiedAt: member.emailVerifiedAt ?? new Date() },
    }),
    prisma.session.deleteMany({ where: { memberId: member.id } }),
  ]);
}

export async function changePassword(memberId: string, sessionId: string, currentPassword: string, newPassword: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { passwordHash: true } });
  if (!member || !(await bcrypt.compare(currentPassword, member.passwordHash))) {
    throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
  }
  const passwordHash = await hash(newPassword);
  await prisma.$transaction([
    prisma.member.update({ where: { id: memberId }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { memberId, NOT: { id: sessionId } } }),
  ]);
}

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
