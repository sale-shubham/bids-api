import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { OTP_TTL_SECONDS, OTP_LENGTH, OTP_RESEND_COOLDOWN_SECONDS } from '@/core/config/constants';
import { AppError, Forbidden, ServiceUnavailable, Unauthorized } from '@/core/errors/AppError';
import { emailProvider } from '@/providers/email';
import type { OtpChannel, OtpPurpose } from '@prisma/client';

// PHONE_VERIFY stays in the DB enum (Postgres cannot drop values) but is never issued.
export type EmailOtpPurpose = Exclude<OtpPurpose, 'PHONE_VERIFY'>;

// OTP-challenge mechanics, email only: signup + forgot-password (SIGNUP / PASSWORD_RESET). Login is email + password.

const CHANNEL: OtpChannel = 'EMAIL';

// Stub driver is deterministic (always env.otp.stubCode) so dev emails are
// always usable without reading logs. A real driver gets a random code.
function generateCode(): string {
  if (env.email.driver === 'stub') return env.otp.stubCode;
  const max = 10 ** OTP_LENGTH;
  return crypto.randomInt(max / 10, max).toString();
}

const SUBJECTS: Record<EmailOtpPurpose, string> = {
  SIGNUP: 'Verify your NobleBid email',
  PASSWORD_RESET: 'Reset your NobleBid password',
};

async function sendOtp(identifier: string, purpose: EmailOtpPurpose, code: string) {
  const expiryMinutes = Math.round(OTP_TTL_SECONDS / 60);
  await emailProvider.send({
    to: identifier,
    subject: SUBJECTS[purpose],
    template: 'otp-code',
    data: { code, purpose, expiryMinutes },
  });
}

// Seconds left before another code may be requested (0 = may send now).
export function cooldownRemainingSec(lastCreatedAt: Date, now: Date = new Date()): number {
  const elapsed = (now.getTime() - lastCreatedAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed));
}

export interface IssueOtpOptions {
  // 'throw' (default): inside the cooldown -> 429. 'skip': a code was sent
  // moments ago, so do nothing and report the remaining wait (used where the
  // caller must not fail, e.g. forgot-password, re-signup, login of unverified).
  onCooldown?: 'throw' | 'skip';
}

// Returns seconds until the next resend is allowed.
export async function issueOtpChallenge(
  identifier: string,
  purpose: EmailOtpPurpose,
  opts: IssueOtpOptions = {},
): Promise<{ resendAfterSec: number }> {
  const channel = CHANNEL;
  const now = new Date();

  const existing = await prisma.otpChallenge.findFirst({
    where: {
      identifier,
      channel,
      purpose,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    const remaining = cooldownRemainingSec(existing.createdAt, now);
    if (remaining > 0) {
      if (opts.onCooldown === 'skip') return { resendAfterSec: remaining };
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'OTP already sent. Please wait before requesting again.', {
        resendAfterSec: remaining,
      });
    }
    // Still within its TTL — resend the same code rather than minting a second live one.
    // Bump createdAt so the cooldown restarts from this resend.
    try {
      await sendOtp(identifier, purpose, existing.code);
    } catch {
      throw ServiceUnavailable('Failed to send OTP. Please try again in a moment.');
    }
    await prisma.otpChallenge.update({ where: { id: existing.id }, data: { createdAt: now } });
    return { resendAfterSec: OTP_RESEND_COOLDOWN_SECONDS };
  }

  const code = generateCode();
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

  const challenge = await prisma.otpChallenge.create({
    data: {
      identifier,
      channel,
      purpose,
      code,
      otpHash,
      expiresAt,
    },
  });

  try {
    await sendOtp(identifier, purpose, code);
  } catch {
    // Delete so the resend cooldown doesn't block the user's next attempt
    // for a code that was never actually delivered.
    await prisma.otpChallenge.delete({ where: { id: challenge.id } });
    throw ServiceUnavailable('Failed to send OTP. Please try again in a moment.');
  }
  return { resendAfterSec: OTP_RESEND_COOLDOWN_SECONDS };
}

export async function consumeOtpChallenge(
  identifier: string,
  purpose: EmailOtpPurpose,
  code: string,
): Promise<void> {
  const channel = CHANNEL;
  const now = new Date();
  const challenge = await prisma.otpChallenge.findFirst({
    where: { identifier, channel, purpose, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  if (!challenge) throw Unauthorized('OTP expired or not requested. Please request a new one.');
  if (challenge.attempts >= challenge.maxAttempts) {
    throw Forbidden('Too many incorrect attempts. Please request a new OTP.');
  }

  const valid = await bcrypt.compare(code, challenge.otpHash);
  if (!valid) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    throw Unauthorized('Incorrect code');
  }
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
}
