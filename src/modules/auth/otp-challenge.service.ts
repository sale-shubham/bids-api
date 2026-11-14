import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { OTP_TTL_SECONDS, OTP_LENGTH, OTP_RESEND_COOLDOWN_SECONDS } from '@/core/config/constants';
import { Forbidden, ServiceUnavailable, TooManyRequests, Unauthorized } from '@/core/errors/AppError';
import { emailProvider } from '@/providers/email';
import type { OtpPurpose } from '@prisma/client';

// Email OTP-challenge mechanics. Used only to verify an email at signup and for
// forgot-password (purpose SIGNUP / PASSWORD_RESET); login is email + password.

// Stub driver is deterministic (always env.otp.stubCode) so dev emails are
// always usable without reading logs. A real driver gets a random code.
function generateCode(): string {
  if (env.email.driver === 'stub') return env.otp.stubCode;
  const max = 10 ** OTP_LENGTH;
  return crypto.randomInt(max / 10, max).toString();
}

export async function issueOtpChallenge(
  identifier: string,
  purpose: OtpPurpose,
): Promise<void> {
  const channel = 'EMAIL' as const;
  const now = new Date();
  const cooldownStart = new Date(now.getTime() - OTP_RESEND_COOLDOWN_SECONDS * 1000);

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
    if (existing.createdAt > cooldownStart) {
      throw TooManyRequests('OTP already sent. Please wait before requesting again.');
    }
    // Still within its TTL — resend the same code rather than minting a second live one.
    try {
      await emailProvider.send(identifier, existing.code);
    } catch (err) {
      throw ServiceUnavailable('Failed to send OTP. Please try again in a moment.');
    }
    return;
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
    await emailProvider.send(identifier, code);
  } catch (err) {
    // Delete so the resend cooldown doesn't block the user's next attempt
    // for a code that was never actually delivered.
    await prisma.otpChallenge.delete({ where: { id: challenge.id } });
    throw ServiceUnavailable('Failed to send OTP. Please try again in a moment.');
  }
}

export async function consumeOtpChallenge(
  identifier: string,
  purpose: OtpPurpose,
  code: string,
): Promise<void> {
  const channel = 'EMAIL' as const;
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
