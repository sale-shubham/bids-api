import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { decryptSecret, encryptSecret, envKey } from '@/core/security/secret-box';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '@/core/security/totp';
import { verifyTwoFactorChallenge } from './token.service';
import { AccountSuspended } from './auth.service';
import { memberProfileSelect, withMemberMoney } from '@/modules/members/member.select';

// TOTP two-factor auth. The secret is AES-256-GCM encrypted (secret-box.ts); recovery codes are stored as sha256.

export const RECOVERY_CODE_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const InvalidTwoFactorCode = () => new AppError(400, 'TWO_FACTOR_INVALID_CODE', 'Invalid verification code');
const AlreadyEnabled = () => new AppError(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
const NotEnabled = () => new AppError(400, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled');

export const normalizeRecoveryCode = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();
export const hashRecoveryCode = (c: string) => crypto.createHash('sha256').update(normalizeRecoveryCode(c)).digest('hex');

/** 10 random codes shaped XXXX-XXXX (base32 alphabet). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const part = () => Array.from({ length: 4 }, () => B32[crypto.randomInt(B32.length)]).join('');
  return Array.from({ length: count }, () => `${part()}-${part()}`);
}

async function replaceRecoveryCodes(memberId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { memberId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ memberId, codeHash: hashRecoveryCode(c) })) }),
  ]);
  return codes;
}

type Factors = { id: string; totpSecretEnc: string | null };

/** True when `input` is a valid TOTP code, or an unused recovery code (which is then burnt). */
async function checkSecondFactor(m: Factors, input: string): Promise<boolean> {
  if (/^\d{6}$/.test(input)) {
    return !!m.totpSecretEnc && verifyTotp(decryptSecret(m.totpSecretEnc), input);
  }
  if (!/^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/.test(input.trim())) return false;
  const row = await prisma.recoveryCode.findFirst({
    where: { memberId: m.id, codeHash: hashRecoveryCode(input), usedAt: null },
    select: { id: true },
  });
  if (!row) return false;
  // Guarded update: two concurrent uses of one code cannot both succeed.
  const { count } = await prisma.recoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return count === 1;
}

async function loadFactors(memberId: string) {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, email: true, passwordHash: true, totpSecretEnc: true, twoFactorEnabledAt: true },
  });
  if (!m) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  return m;
}

export async function setup(memberId: string) {
  envKey();
  const m = await loadFactors(memberId);
  if (m.twoFactorEnabledAt) throw AlreadyEnabled();
  const secret = generateTotpSecret();
  await prisma.member.update({ where: { id: memberId }, data: { totpSecretEnc: encryptSecret(secret) } });
  return { secret, otpauthUrl: otpauthUrl(secret, m.email) };
}

export async function enable(memberId: string, code: string) {
  envKey();
  const m = await loadFactors(memberId);
  if (m.twoFactorEnabledAt) throw AlreadyEnabled();
  if (!m.totpSecretEnc || !/^\d{6}$/.test(code) || !verifyTotp(decryptSecret(m.totpSecretEnc), code)) throw InvalidTwoFactorCode();
  await prisma.member.update({ where: { id: memberId }, data: { twoFactorEnabledAt: new Date() } });
  return { recoveryCodes: await replaceRecoveryCodes(memberId) };
}

export async function disable(memberId: string, password: string, code: string) {
  const m = await loadFactors(memberId);
  if (!(await bcrypt.compare(password, m.passwordHash))) {
    throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
  }
  if (!m.twoFactorEnabledAt) throw NotEnabled();
  if (!(await checkSecondFactor(m, code))) throw InvalidTwoFactorCode();
  await prisma.$transaction([
    prisma.member.update({ where: { id: memberId }, data: { totpSecretEnc: null, twoFactorEnabledAt: null } }),
    prisma.recoveryCode.deleteMany({ where: { memberId } }),
  ]);
}

export async function regenerateRecoveryCodes(memberId: string, code: string) {
  const m = await loadFactors(memberId);
  if (!m.twoFactorEnabledAt) throw NotEnabled();
  if (!(await checkSecondFactor(m, code))) throw InvalidTwoFactorCode();
  return { recoveryCodes: await replaceRecoveryCodes(memberId) };
}

/** Second login step: challenge token + TOTP code or recovery code -> the member (caller starts the session). */
export async function verifyLogin(input: { challengeToken: string; code?: string; recoveryCode?: string }) {
  const { sub, deviceInfo } = verifyTwoFactorChallenge(input.challengeToken);
  const m = await prisma.member.findUnique({
    where: { id: sub },
    select: { ...memberProfileSelect, isActive: true, totpSecretEnc: true },
  });
  if (!m || !m.twoFactorEnabledAt) {
    throw new AppError(401, 'TWO_FACTOR_CHALLENGE_INVALID', 'Sign-in expired. Please log in again.');
  }
  if (!m.isActive) throw AccountSuspended();
  if (!(await checkSecondFactor(m, input.code ?? input.recoveryCode ?? ''))) throw InvalidTwoFactorCode();
  const { totpSecretEnc: _omit, ...safe } = m;
  return { member: withMemberMoney(safe), deviceInfo };
}
