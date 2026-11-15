import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));
vi.mock('@/modules/auth/session.service', async (orig) => ({
  ...(await orig<object>()),
  upsertDeviceSession: vi.fn(async (memberId: string) => ({ id: `s-${memberId}` })),
}));
vi.mock('@/modules/settings/device-limit.service', () => ({ getMaxDevicesForRole: async () => 3 }));

const PASSWORD = 'abcdefg1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

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

beforeEach(() => {
  resetPrismaMock();
});

describe('POST /auth/login', () => {
  it('always creates the session: cookies set and a member body without removed fields', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ ...baseMember, passwordHash: PASSWORD_HASH });
    const res = await post('/auth/login', { email: 'asha@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(hasCookie(res, 'nb_at') && hasCookie(res, 'nb_rt')).toBe(true);
    expect(res.body.data.twoFactorRequired).toBeUndefined();
    expect(res.body.data.member).toMatchObject({ id: 'm1', verified: false, deviceLimit: 3 });
    for (const k of ['twoFactorEnabled', 'twoFactorSetupRequired', 'phoneVerifiedAt', 'whatsappOptIn', 'totpSecretEnc']) {
      expect(res.body.data.member).not.toHaveProperty(k);
    }
  });

  it('a suspended member is refused', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ ...baseMember, passwordHash: PASSWORD_HASH, isActive: false });
    const res = await post('/auth/login', { email: 'asha@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(cookies(res)).toEqual([]);
  });

  it('a token without a sid claim is not an access token', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('@/core/config/env');
    const token = jwt.sign({ sub: 'm1', role: 'BIDDER' }, env.jwt.accessSecret, { expiresIn: 300 });
    const res = await request(await getApp()).get('/members/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
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
