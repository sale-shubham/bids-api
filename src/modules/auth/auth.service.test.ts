import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  member: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  session: { deleteMany: vi.fn() },
}));
const otp = vi.hoisted(() => ({ issueOtpChallenge: vi.fn(), consumeOtpChallenge: vi.fn() }));
const mail = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('./otp-challenge.service', () => otp);
vi.mock('@/providers/email', () => ({ emailProvider: mail }));
vi.mock('./session.service', () => ({ upsertDeviceSession: vi.fn(), touchSession: vi.fn() }));

import * as auth from './auth.service';

const hash = bcrypt.hashSync('correct1pass', 4);
const base = { id: 'm1', email: 'a@b.co', name: 'A', role: 'MEMBER', isActive: true, passwordHash: hash, unpaidCommissionPaise: 0n, moneySpentPaise: 0n };

beforeEach(() => {
  vi.clearAllMocks();
  otp.issueOtpChallenge.mockResolvedValue({ resendAfterSec: 30 });
});

describe('login error mapping', () => {
  it('unknown email -> 401 INVALID_CREDENTIALS', async () => {
    db.member.findUnique.mockResolvedValue(null);
    await expect(auth.login('x@y.co', 'whatever1')).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
  });
  it('wrong password -> same 401 INVALID_CREDENTIALS and message', async () => {
    db.member.findUnique.mockResolvedValue({ ...base, emailVerifiedAt: new Date() });
    const wrong = await auth.login('a@b.co', 'wrongpass1').catch((e) => e);
    db.member.findUnique.mockResolvedValue(null);
    const unknown = await auth.login('x@y.co', 'wrongpass1').catch((e) => e);
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.message).toBe(unknown.message);
  });
  it('unverified -> 403 EMAIL_NOT_VERIFIED and a fresh SIGNUP code', async () => {
    db.member.findUnique.mockResolvedValue({ ...base, emailVerifiedAt: null });
    await expect(auth.login('a@b.co', 'correct1pass')).rejects.toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect(otp.issueOtpChallenge).toHaveBeenCalledWith('a@b.co', 'SIGNUP', { onCooldown: 'skip' });
  });
  it('inactive -> 403 ACCOUNT_SUSPENDED', async () => {
    db.member.findUnique.mockResolvedValue({ ...base, emailVerifiedAt: new Date(), isActive: false });
    await expect(auth.login('a@b.co', 'correct1pass')).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_SUSPENDED' });
  });
  it('success never returns passwordHash', async () => {
    db.member.findUnique.mockResolvedValue({ ...base, emailVerifiedAt: new Date() });
    const m = await auth.login('a@b.co', 'correct1pass');
    expect(m).not.toHaveProperty('passwordHash');
    expect(m.id).toBe('m1');
  });
});

describe('signup', () => {
  const input = { name: 'New', email: 'a@b.co', password: 'newpass12' };

  it('verified email -> 409 EMAIL_TAKEN', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1', emailVerifiedAt: new Date() });
    await expect(auth.signup(input)).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
    expect(db.member.create).not.toHaveBeenCalled();
  });
  it('existing unverified -> updates name/password (never the role) and resends', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1', emailVerifiedAt: null });
    const r = await auth.signup(input);
    expect(db.member.create).not.toHaveBeenCalled();
    const data = db.member.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: 'New' });
    expect(data).not.toHaveProperty('role');
    expect(await bcrypt.compare('newpass12', data.passwordHash)).toBe(true);
    expect(otp.issueOtpChallenge).toHaveBeenCalledWith('a@b.co', 'SIGNUP', { onCooldown: 'skip' });
    expect(r).toEqual({ resendAfterSec: 30 });
  });
  it('new email -> creates unverified member', async () => {
    db.member.findUnique.mockResolvedValue(null);
    await auth.signup(input);
    expect(db.member.create.mock.calls[0][0].data).toMatchObject({ email: 'a@b.co', emailVerifiedAt: null, role: 'MEMBER' });
  });
});

describe('forgotPassword', () => {
  it('unknown email: no OTP, same response', async () => {
    db.member.findUnique.mockResolvedValue(null);
    expect(await auth.forgotPassword('x@y.co')).toEqual({ resendAfterSec: 30 });
    expect(otp.issueOtpChallenge).not.toHaveBeenCalled();
  });
  it('send failure is swallowed', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1' });
    otp.issueOtpChallenge.mockRejectedValue(new Error('ses down'));
    await expect(auth.forgotPassword('a@b.co')).resolves.toEqual({ resendAfterSec: 30 });
  });
});
