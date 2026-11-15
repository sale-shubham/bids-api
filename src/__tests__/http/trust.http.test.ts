import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));
vi.mock('@/modules/auth/session.service', async (orig) => ({
  ...(await orig<object>()),
  upsertDeviceSession: vi.fn(async (memberId: string) => ({ id: `s-${memberId}` })),
}));
vi.mock('@/modules/settings/device-limit.service', () => ({ getMaxDevicesForRole: async () => 3 }));

// Pinned before the app (and env.ts) is first imported.
const ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.TOTP_ENC_KEY = ENC_KEY;

const PASSWORD = 'abcdefg1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const SECRET = 'JBSWY3DPEHPK3PXP';

const baseMember = {
  id: 'm1',
  email: 'asha@example.com',
  name: 'Asha',
  phone: null,
  avatarUrl: null,
  address: null,
  role: 'BIDDER',
  isActive: true,
  emailVerifiedAt: new Date('2026-01-01'),
  phoneVerifiedAt: null,
  twoFactorEnabledAt: null,
  verifiedAt: null,
  unpaidCommissionPaise: 0n,
  auctionsWon: 0,
  moneySpentPaise: 0n,
  createdAt: new Date('2026-01-01'),
};

const cookies = (res: request.Response): string[] => [res.headers['set-cookie'] ?? []].flat();
const hasCookie = (res: request.Response, name: string) => cookies(res).some((c) => c.startsWith(`${name}=`));
const post = async (path: string, body: object, auth?: string) => {
  const r = request(await getApp()).post(path);
  if (auth) r.set('Authorization', auth);
  return r.send(body);
};

async function encSecret() {
  const { encryptSecret } = await import('@/core/security/secret-box');
  return encryptSecret(SECRET);
}
async function currentCode(offsetSteps = 0) {
  const { totpAt } = await import('@/core/security/totp');
  return totpAt(SECRET, Date.now() + offsetSteps * 30_000);
}

beforeEach(() => {
  resetPrismaMock();
});

describe('login with 2FA enabled', () => {
  it('returns a challenge and sets no cookies / creates no session', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ ...baseMember, passwordHash: PASSWORD_HASH, twoFactorEnabledAt: new Date() });
    const res = await post('/auth/login', { email: 'asha@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ twoFactorRequired: true, challengeToken: expect.any(String) });
    expect(cookies(res)).toEqual([]);
    const claims = jwt.decode(res.body.data.challengeToken) as { typ: string; sub: string; exp: number; iat: number };
    expect(claims).toMatchObject({ typ: '2fa', sub: 'm1' });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('a member without 2FA still gets cookies and a member body', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ ...baseMember, passwordHash: PASSWORD_HASH });
    const res = await post('/auth/login', { email: 'asha@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(hasCookie(res, 'nb_at')).toBe(true);
    expect(res.body.data.member).toMatchObject({ id: 'm1', twoFactorEnabled: false, phoneVerifiedAt: null });
    expect(res.body.data.member.twoFactorEnabledAt).toBeUndefined();
  });

  it('a challenge token cannot be used as an access token', async () => {
    const { signTwoFactorChallenge } = await import('@/modules/auth/token.service');
    const res = await request(await getApp())
      .get('/members/me')
      .set('Authorization', `Bearer ${signTwoFactorChallenge('m1')}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/2fa/verify', () => {
  const challenge = async () => (await import('@/modules/auth/token.service')).signTwoFactorChallenge('m1');
  const enrolled = async () => ({ ...baseMember, twoFactorEnabledAt: new Date(), totpSecretEnc: await encSecret() });

  it('valid code -> same session cookies and member body as a normal login', async () => {
    prismaMock.member.findUnique.mockResolvedValue(await enrolled());
    const res = await post('/auth/2fa/verify', { challengeToken: await challenge(), code: await currentCode() });
    expect(res.status).toBe(200);
    expect(hasCookie(res, 'nb_at') && hasCookie(res, 'nb_rt')).toBe(true);
    expect(res.body.data.member).toMatchObject({ id: 'm1', twoFactorEnabled: true, deviceLimit: 3 });
    const { memberProfileSelect } = await import('@/modules/members/member.select');
    expect(memberProfileSelect).not.toHaveProperty('totpSecretEnc');
    expect(memberProfileSelect).not.toHaveProperty('passwordHash');
  });

  it('accepts the previous time step (clock drift window)', async () => {
    prismaMock.member.findUnique.mockResolvedValue(await enrolled());
    const res = await post('/auth/2fa/verify', { challengeToken: await challenge(), code: await currentCode(-1) });
    expect(res.status).toBe(200);
  });

  it('wrong code -> 400 TWO_FACTOR_INVALID_CODE and no cookies', async () => {
    prismaMock.member.findUnique.mockResolvedValue(await enrolled());
    const good = await currentCode();
    const bad = good === '000000' ? '111111' : '000000';
    const res = await post('/auth/2fa/verify', { challengeToken: await challenge(), code: bad });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(cookies(res)).toEqual([]);
  });

  it('expired / garbage / wrong-type token -> 401 TWO_FACTOR_CHALLENGE_INVALID', async () => {
    const { env } = await import('@/core/config/env');
    const expired = jwt.sign({ typ: '2fa', sub: 'm1' }, env.jwt.accessSecret, { expiresIn: -10 });
    const accessLike = jwt.sign({ sub: 'm1', role: 'BIDDER', sid: 's-m1' }, env.jwt.accessSecret, { expiresIn: 300 });
    for (const token of [expired, 'garbage', accessLike]) {
      const res = await post('/auth/2fa/verify', { challengeToken: token, code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    }
  });

  it('recovery code works once: it is stamped usedAt, and a used code is rejected', async () => {
    prismaMock.member.findUnique.mockResolvedValue(await enrolled());
    prismaMock.recoveryCode.findFirst.mockResolvedValueOnce({ id: 'rc1' }).mockResolvedValueOnce(null);
    prismaMock.recoveryCode.updateMany.mockResolvedValue({ count: 1 });
    const token = await challenge();

    const first = await post('/auth/2fa/verify', { challengeToken: token, recoveryCode: 'abcd-2345' });
    expect(first.status).toBe(200);
    expect(hasCookie(first, 'nb_at')).toBe(true);
    const { hashRecoveryCode } = await import('@/modules/auth/two-factor.service');
    expect(prismaMock.recoveryCode.findFirst).toHaveBeenCalledWith({
      where: { memberId: 'm1', codeHash: hashRecoveryCode('ABCD-2345'), usedAt: null },
      select: { id: true },
    });
    expect(prismaMock.recoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'rc1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });

    const second = await post('/auth/2fa/verify', { challengeToken: token, recoveryCode: 'abcd-2345' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
  });

  it('a recovery code lost to a concurrent use (updateMany count 0) is rejected', async () => {
    prismaMock.member.findUnique.mockResolvedValue(await enrolled());
    prismaMock.recoveryCode.findFirst.mockResolvedValue({ id: 'rc1' });
    prismaMock.recoveryCode.updateMany.mockResolvedValue({ count: 0 });
    const res = await post('/auth/2fa/verify', { challengeToken: await challenge(), recoveryCode: 'ABCD-2345' });
    expect(res.status).toBe(400);
  });

  it('a suspended member is refused', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ ...(await enrolled()), isActive: false });
    const res = await post('/auth/2fa/verify', { challengeToken: await challenge(), code: await currentCode() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('2FA setup / enable / disable / recovery codes', () => {
  it('setup stores an encrypted secret and returns secret + otpauth url', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, email: 'asha@example.com', totpSecretEnc: null, twoFactorEnabledAt: null });
    const res = await post('/auth/2fa/setup', {}, await bearer('BIDDER'));
    expect(res.status).toBe(200);
    const { secret, otpauthUrl } = res.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toBe(`otpauth://totp/NobleBid:asha%40example.com?secret=${secret}&issuer=NobleBid`);
    const stored = prismaMock.member.update.mock.calls[0][0].data.totpSecretEnc as string;
    expect(stored).not.toContain(secret);
    const { decryptSecret } = await import('@/core/security/secret-box');
    expect(decryptSecret(stored)).toBe(secret);
  });

  it('setup when already enabled -> 409 TWO_FACTOR_ALREADY_ENABLED', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, email: 'a@x.test', twoFactorEnabledAt: new Date() });
    const res = await post('/auth/2fa/setup', {}, await bearer('BIDDER'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });

  it('enable with a wrong code -> 400, nothing enabled', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, email: 'a@x.test', totpSecretEnc: await encSecret(), twoFactorEnabledAt: null });
    const good = await currentCode();
    const res = await post('/auth/2fa/enable', { code: good === '000000' ? '111111' : '000000' }, await bearer('BIDDER'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(prismaMock.member.update).not.toHaveBeenCalled();
  });

  it('enable with the right code sets twoFactorEnabledAt and returns 10 recovery codes once (hashed at rest)', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, email: 'a@x.test', totpSecretEnc: await encSecret(), twoFactorEnabledAt: null });
    const res = await post('/auth/2fa/enable', { code: await currentCode() }, await bearer('BIDDER'));
    expect(res.status).toBe(200);
    const codes: string[] = res.body.data.recoveryCodes;
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(new Set(codes).size).toBe(10);
    expect(prismaMock.member.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { twoFactorEnabledAt: expect.any(Date) } }),
    );
    const rows = prismaMock.recoveryCode.createMany.mock.calls[0][0].data as { codeHash: string }[];
    expect(rows).toHaveLength(10);
    expect(JSON.stringify(rows)).not.toContain(codes[0]);
    const { hashRecoveryCode } = await import('@/modules/auth/two-factor.service');
    expect(rows[0].codeHash).toBe(hashRecoveryCode(codes[0]));
  });

  it('disable needs the password and a valid code (a recovery code is accepted), then clears everything', async () => {
    const member = { id: 'm1', isActive: true, email: 'a@x.test', passwordHash: PASSWORD_HASH, totpSecretEnc: await encSecret(), twoFactorEnabledAt: new Date() };
    prismaMock.member.findUnique.mockResolvedValue(member);

    const badPw = await post('/auth/2fa/disable', { password: 'wrong-password1', code: await currentCode() }, await bearer('BIDDER'));
    expect(badPw.status).toBe(400);
    expect(badPw.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

    const ok = await post('/auth/2fa/disable', { password: PASSWORD, code: await currentCode() }, await bearer('BIDDER'));
    expect(ok.status).toBe(200);
    expect(prismaMock.member.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { totpSecretEnc: null, twoFactorEnabledAt: null } }),
    );
    expect(prismaMock.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'm1' } });

    prismaMock.member.update.mockClear();
    prismaMock.recoveryCode.findFirst.mockResolvedValue({ id: 'rc1' });
    prismaMock.recoveryCode.updateMany.mockResolvedValue({ count: 1 });
    const viaRecovery = await post('/auth/2fa/disable', { password: PASSWORD, code: 'ABCD-2345' }, await bearer('BIDDER'));
    expect(viaRecovery.status).toBe(200);
  });

  it('regenerate replaces the codes after a valid code', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, totpSecretEnc: await encSecret(), twoFactorEnabledAt: new Date() });
    const res = await post('/auth/2fa/recovery-codes', { code: await currentCode() }, await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.data.recoveryCodes).toHaveLength(10);
    expect(prismaMock.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'm1' } });

    const bad = await post('/auth/2fa/recovery-codes', { code: '000000' === (await currentCode()) ? '111111' : '000000' }, await bearer('BIDDER'));
    expect(bad.status).toBe(400);
  });

  it('missing TOTP_ENC_KEY -> 503 TWO_FACTOR_UNAVAILABLE on setup and enable; login unaffected', async () => {
    const { env } = await import('@/core/config/env');
    const mutable = env as unknown as { twoFactor: { encKey: string } };
    const saved = mutable.twoFactor.encKey;
    mutable.twoFactor.encKey = '';
    try {
      prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, email: 'a@x.test', twoFactorEnabledAt: null });
      for (const [path, body] of [['/auth/2fa/setup', {}], ['/auth/2fa/enable', { code: '123456' }]] as const) {
        const res = await post(path, body, await bearer('BIDDER'));
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('TWO_FACTOR_UNAVAILABLE');
      }
      prismaMock.member.findUnique.mockResolvedValue({ ...baseMember, passwordHash: PASSWORD_HASH });
      expect((await post('/auth/login', { email: 'asha@example.com', password: PASSWORD })).status).toBe(200);
    } finally {
      mutable.twoFactor.encKey = saved;
    }
  });
});

describe('REQUIRE_ADMIN_2FA enforcement on /admin', () => {
  async function withFlag(value: boolean, fn: () => Promise<void>) {
    const { env } = await import('@/core/config/env');
    const mutable = env as unknown as { twoFactor: { requireAdmin: boolean } };
    const saved = mutable.twoFactor.requireAdmin;
    mutable.twoFactor.requireAdmin = value;
    try {
      await fn();
    } finally {
      mutable.twoFactor.requireAdmin = saved;
    }
  }
  const adminGet = async (path: string) =>
    request(await getApp()).get(path).set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));

  it('on: an admin without 2FA gets 403 TWO_FACTOR_SETUP_REQUIRED on every admin route', async () => {
    await withFlag(true, async () => {
      prismaMock.member.findUnique.mockResolvedValue({ id: 'admin1', twoFactorEnabledAt: null });
      for (const path of ['/admin/members', '/admin/reports', '/admin/dashboard']) {
        const res = await adminGet(path);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
      }
    });
  });

  it('on: the /auth/2fa/* setup routes stay reachable', async () => {
    await withFlag(true, async () => {
      prismaMock.member.findUnique.mockResolvedValue({ id: 'admin1', email: 'admin@x.test', twoFactorEnabledAt: null });
      const res = await post('/auth/2fa/setup', {}, await bearer('SUPER_ADMIN', 'admin1'));
      expect(res.status).toBe(200);
    });
  });

  it('on: an admin with 2FA passes the guard', async () => {
    await withFlag(true, async () => {
      prismaMock.member.findUnique.mockResolvedValue({ id: 'admin1', twoFactorEnabledAt: new Date() });
      const res = await adminGet('/admin/reports');
      expect(res.body?.error?.code).not.toBe('TWO_FACTOR_SETUP_REQUIRED');
    });
  });

  it('off (default): an admin without 2FA is not blocked', async () => {
    await withFlag(false, async () => {
      prismaMock.member.findUnique.mockResolvedValue({ id: 'admin1', twoFactorEnabledAt: null });
      const res = await adminGet('/admin/reports');
      expect(res.body?.error?.code).not.toBe('TWO_FACTOR_SETUP_REQUIRED');
      expect(res.status).not.toBe(403);
    });
  });

  it('GET /members/me flags twoFactorSetupRequired only for an un-enrolled admin when the flag is on', async () => {
    const admin = { ...baseMember, id: 'admin1', role: 'SUPER_ADMIN' };
    await withFlag(true, async () => {
      prismaMock.member.findUnique.mockResolvedValue(admin);
      const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));
      expect(res.body.data.member.twoFactorSetupRequired).toBe(true);
      prismaMock.member.findUnique.mockResolvedValue({ ...admin, twoFactorEnabledAt: new Date() });
      const enrolled = await request(await getApp()).get('/members/me').set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));
      expect(enrolled.body.data.member.twoFactorSetupRequired).toBe(false);
    });
    await withFlag(false, async () => {
      prismaMock.member.findUnique.mockResolvedValue(admin);
      const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));
      expect(res.body.data.member.twoFactorSetupRequired).toBe(false);
    });
  });
});

describe('phone verification', () => {
  it('POST /members/me/phone/otp stores a challenge keyed by the E.164 number and answers with a masked number', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue(null);
    prismaMock.otpChallenge.create.mockResolvedValue({ id: 'c1' });
    const res = await post('/members/me/phone/otp', { phone: '9876543210' }, await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sentTo: '+91******3210' });
    expect(prismaMock.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ identifier: '+919876543210', channel: 'SMS', purpose: 'PHONE_VERIFY' }),
    });
  });

  it('a resend inside the cooldown -> 429', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue({ id: 'c1', code: '123456', createdAt: new Date() });
    const res = await post('/members/me/phone/otp', { phone: '9876543210' }, await bearer('BIDDER'));
    expect(res.status).toBe(429);
  });

  it('verify with the right code stores phone + phoneVerifiedAt and returns the member', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue({
      id: 'c1',
      attempts: 0,
      maxAttempts: 5,
      otpHash: bcrypt.hashSync('123456', 4),
    });
    prismaMock.member.findUnique.mockResolvedValue({
      ...baseMember,
      phone: '9876543210',
      phoneVerifiedAt: new Date(),
      role: 'AUCTIONEER',
      payoutAccount: null,
    });
    const res = await post('/members/me/phone/verify', { phone: '9876543210', code: '123456' }, await bearer('AUCTIONEER'));
    expect(res.status).toBe(200);
    expect(prismaMock.member.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { phone: '9876543210', phoneVerifiedAt: expect.any(Date) },
    });
    expect(res.body.data.member.phoneVerifiedAt).toEqual(expect.any(String));
  });

  it('verify with a wrong code -> 401 and the phone is untouched', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue({ id: 'c1', attempts: 0, maxAttempts: 5, otpHash: bcrypt.hashSync('123456', 4) });
    const res = await post('/members/me/phone/verify', { phone: '9876543210', code: '000000' }, await bearer('BIDDER'));
    expect(res.status).toBe(401);
    expect(prismaMock.member.update).not.toHaveBeenCalled();
  });

  it('verify after too many attempts -> 403; with no challenge -> 401', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue({ id: 'c1', attempts: 5, maxAttempts: 5, otpHash: 'x' });
    expect((await post('/members/me/phone/verify', { phone: '9876543210', code: '123456' }, await bearer('BIDDER'))).status).toBe(403);
    prismaMock.otpChallenge.findFirst.mockResolvedValue(null);
    expect((await post('/members/me/phone/verify', { phone: '9876543210', code: '123456' }, await bearer('BIDDER'))).status).toBe(401);
  });
});

describe('POST /reports', () => {
  const body = { targetType: 'AUCTION', targetId: 'a1', reason: 'COUNTERFEIT', details: 'Fake watch' };

  it('201 { report: { id, status } } and every active SUPER_ADMIN is notified', async () => {
    prismaMock.auction.findFirst.mockResolvedValue({ sellerId: 'seller1', title: 'Vintage Watch' });
    prismaMock.report.create.mockResolvedValue({ id: 'r1', status: 'OPEN' });
    prismaMock.member.findMany.mockResolvedValue([{ id: 'adm1' }, { id: 'adm2' }]);
    const res = await post('/reports', body, await bearer('BIDDER'));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ report: { id: 'r1', status: 'OPEN' } });
    expect(prismaMock.report.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reporterId: 'm1', targetType: 'AUCTION', targetId: 'a1', reason: 'COUNTERFEIT', details: 'Fake watch' } }),
    );
    expect(prismaMock.member.findMany).toHaveBeenCalledWith({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } });
    // Notifications run inline here (no queue): one row per admin with the documented dedupe key.
    const keys = prismaMock.notification.findUnique.mock.calls.map((c: unknown[]) => (c[0] as { where: { dedupeKey: string } }).where.dedupeKey);
    expect(keys).toEqual(['report-filed:r1:adm1', 'report-filed:r1:adm2']);
  });

  it('404 REPORT_TARGET_NOT_FOUND for a missing / deleted target', async () => {
    prismaMock.auction.findFirst.mockResolvedValue(null);
    const res = await post('/reports', body, await bearer('BIDDER'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REPORT_TARGET_NOT_FOUND');
    expect(prismaMock.auction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a1', deletedAt: null } }));
  });

  it.each([
    ['own auction', { targetType: 'AUCTION', targetId: 'a1' }, 'auction.findFirst', { sellerId: 'm1', title: 'T' }],
    ['yourself', { targetType: 'MEMBER', targetId: 'm1' }, 'member.findFirst', { id: 'm1', name: 'Me' }],
    ['own review', { targetType: 'REVIEW', targetId: 'rv1' }, 'review.findUnique', { reviewerId: 'm1', comment: 'c' }],
    ['own question', { targetType: 'QUESTION', targetId: 'q1' }, 'auctionQuestion.findUnique', { askerId: 'm1', question: 'q' }],
  ])('400 INVALID_REPORT when reporting %s', async (_n, target, fn, row) => {
    const [model, method] = fn.split('.');
    prismaMock[model][method].mockResolvedValue(row);
    const res = await post('/reports', { ...body, ...target }, await bearer('BIDDER'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REPORT');
    expect(prismaMock.report.create).not.toHaveBeenCalled();
  });

  it('409 ALREADY_REPORTED on the unique (reporter, target) violation', async () => {
    prismaMock.auction.findFirst.mockResolvedValue({ sellerId: 'seller1', title: 'T' });
    prismaMock.report.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await post('/reports', body, await bearer('BIDDER'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_REPORTED');
  });
});
