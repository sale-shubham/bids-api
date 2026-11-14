import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  otpChallenge: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
const mail = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/providers/email', () => ({ emailProvider: mail }));

import { cooldownRemainingSec, issueOtpChallenge } from './otp-challenge.service';
import { OTP_RESEND_COOLDOWN_SECONDS } from '@/core/config/constants';

beforeEach(() => vi.clearAllMocks());

describe('cooldownRemainingSec', () => {
  it('counts down and floors at 0', () => {
    const now = new Date('2026-01-01T00:01:00Z');
    expect(cooldownRemainingSec(new Date(now.getTime() - 10_000), now)).toBe(OTP_RESEND_COOLDOWN_SECONDS - 10);
    expect(cooldownRemainingSec(new Date(now.getTime() - 60_000), now)).toBe(0);
  });
});

describe('issueOtpChallenge cooldown', () => {
  const recent = { id: 'c1', code: '123456', createdAt: new Date(Date.now() - 5_000) };

  it('throws 429 with resendAfterSec inside the cooldown', async () => {
    db.otpChallenge.findFirst.mockResolvedValue(recent);
    await expect(issueOtpChallenge('a@b.co', 'SIGNUP')).rejects.toMatchObject({
      statusCode: 429,
      details: { resendAfterSec: expect.any(Number) },
    });
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('skip mode returns the remaining wait without sending', async () => {
    db.otpChallenge.findFirst.mockResolvedValue(recent);
    const r = await issueOtpChallenge('a@b.co', 'SIGNUP', { onCooldown: 'skip' });
    expect(r.resendAfterSec).toBeGreaterThan(0);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('resends the same code after the cooldown, purpose-aware', async () => {
    db.otpChallenge.findFirst.mockResolvedValue({ ...recent, createdAt: new Date(Date.now() - 60_000) });
    await issueOtpChallenge('a@b.co', 'PASSWORD_RESET');
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.co',
        template: 'otp-code',
        data: expect.objectContaining({ code: '123456', purpose: 'PASSWORD_RESET' }),
      }),
    );
  });
});
