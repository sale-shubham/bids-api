import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

const doubles = vi.hoisted(() => ({
  presignPut: vi.fn(async () => 'https://s3.test/signed-put'),
  push: { subscribe: vi.fn(), unsubscribe: vi.fn(), vapidPublicKey: vi.fn(() => 'BPUBLICKEY') },
  runRetentionPurge: vi.fn(),
}));
vi.mock('@/providers/storage', () => ({
  storage: {
    keyFor: (folder: string, ext: string) => `${folder}/uuid${ext}`,
    presignPut: doubles.presignPut,
    url: (key: string) => `https://cdn.noblebid.test/${key}`,
  },
}));
vi.mock('@/modules/push/push.service', () => doubles.push);
vi.mock('@/modules/admin/retention/admin-retention.service', () => ({ runRetentionPurge: doubles.runRetentionPurge }));

beforeEach(() => {
  resetPrismaMock();
  doubles.presignPut.mockClear();
  doubles.presignPut.mockResolvedValue('https://s3.test/signed-put');
  doubles.runRetentionPurge.mockReset();
});

describe('uploads', () => {
  const body = { folder: 'auctions', contentType: 'image/webp', size: 2048 };

  it('POST /uploads/presign -> { uploadUrl, key, url } with a server-generated key', async () => {
    const res = await request(await getApp()).post('/uploads/presign').set('Authorization', await bearer('AUCTIONEER')).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      uploadUrl: 'https://s3.test/signed-put',
      key: 'auctions/uuid.webp',
      url: 'https://cdn.noblebid.test/auctions/uuid.webp',
    });
    expect(doubles.presignPut).toHaveBeenCalledWith('auctions/uuid.webp', 'image/webp', 2048);
  });

  it('storage failure -> 503 SERVICE_UNAVAILABLE without the provider error', async () => {
    doubles.presignPut.mockRejectedValue(new Error('AccessDenied arn:aws:iam::123:role/x'));
    const res = await request(await getApp()).post('/uploads/presign').set('Authorization', await bearer('BIDDER')).send(body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.text).not.toContain('arn:aws');
  });
});

describe('push', () => {
  it('GET /push/vapid-public-key is public', async () => {
    const res = await request(await getApp()).get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ publicKey: 'BPUBLICKEY' });
  });

  it('POST /push/subscribe -> 201; POST /push/unsubscribe -> 200', async () => {
    doubles.push.subscribe.mockResolvedValue({ subscribed: true });
    doubles.push.unsubscribe.mockResolvedValue({ unsubscribed: true });
    const app = await getApp();
    const auth = await bearer('BIDDER');
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } };
    const created = await request(app).post('/push/subscribe').set('Authorization', auth).set('User-Agent', 'vitest-agent').send(sub);
    expect(created.status).toBe(201);
    expect(doubles.push.subscribe).toHaveBeenCalledWith('m1', 's-m1', expect.objectContaining(sub), 'vitest-agent');
    const gone = await request(app).post('/push/unsubscribe').set('Authorization', auth).send({ endpoint: sub.endpoint });
    expect(gone.status).toBe(200);
  });
});

describe('members', () => {
  const profile = { id: 'm1', name: 'Asha', email: 'a@example.com', role: 'BIDDER', isActive: true, unpaidCommissionPaise: 0n, moneySpentPaise: 0n };

  it('GET /members/me -> { member } incl. deviceLimit, never the password hash', async () => {
    prismaMock.member.findFirst.mockResolvedValue(profile);
    prismaMock.member.findUnique.mockResolvedValue(profile);
    prismaMock.appSetting.findUnique.mockResolvedValue(null);
    const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.data.member).toMatchObject({ id: 'm1', name: 'Asha' });
    expect(res.body.data.member).toHaveProperty('deviceLimit');
    expect(res.body.data.member).not.toHaveProperty('passwordHash');
  });

  it('PATCH /members/me rejects an avatar that is not an uploaded platform image', async () => {
    const res = await request(await getApp())
      .patch('/members/me')
      .set('Authorization', await bearer('BIDDER'))
      .send({ avatarUrl: 'https://evil.example.com/a.png' });
    expect(res.status).toBe(400);
    expect(prismaMock.member.update).not.toHaveBeenCalled();
  });

  it('GET /members/:id/public -> 404 for an unknown member', async () => {
    prismaMock.member.findFirst.mockResolvedValue(null);
    prismaMock.member.findUnique.mockResolvedValue(null);
    const res = await request(await getApp()).get('/members/nobody/public');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('notifications', () => {
  it('GET /notifications/unread-count and POST /notifications/read-all -> envelope', async () => {
    prismaMock.notification.count.mockResolvedValue(4);
    prismaMock.notification.updateMany.mockResolvedValue({ count: 4 });
    const app = await getApp();
    const auth = await bearer('BIDDER');
    const unread = await request(app).get('/notifications/unread-count').set('Authorization', auth);
    expect(unread.status).toBe(200);
    expect(unread.body.success).toBe(true);
    const all = await request(app).post('/notifications/read-all').set('Authorization', auth);
    expect(all.status).toBe(200);
  });

  it('GET /notifications -> paged envelope with meta', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    prismaMock.notification.count.mockResolvedValue(0);
    const res = await request(await getApp()).get('/notifications?pageSize=10').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 10 });
  });
});

describe('admin', () => {
  const admin = () => bearer('SUPER_ADMIN', 'admin1');

  it('POST /admin/retention/purge forwards the validated overrides and strips unknown keys', async () => {
    doubles.runRetentionPurge.mockResolvedValue({ otpChallenges: 3, sessions: 1 });
    const res = await request(await getApp())
      .post('/admin/retention/purge')
      .set('Authorization', await admin())
      .send({ otpChallengeDays: '14', bogus: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ otpChallenges: 3, sessions: 1 });
    expect(doubles.runRetentionPurge).toHaveBeenCalledWith({ otpChallengeDays: 14 });
  });

  it('GET /admin/payments and /admin/commissions -> paged envelopes', async () => {
    prismaMock.paymentOrder.findMany.mockResolvedValue([]);
    prismaMock.paymentOrder.count.mockResolvedValue(0);
    prismaMock.commission.findMany.mockResolvedValue([]);
    prismaMock.commission.count.mockResolvedValue(0);
    const app = await getApp();
    for (const path of ['/admin/payments', '/admin/commissions?status=all']) {
      const res = await request(app).get(path).set('Authorization', await admin());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: [], meta: { total: 0, page: 1, pageSize: 20, totalPages: 1 } });
    }
  });
});
