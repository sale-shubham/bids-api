import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable stand-ins, reset per test. push.service caches its configured
// web-push client per module, so every test imports a fresh copy.
const env = { push: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', vapidSubject: 'https://app.example.com' } };
type Row = { id: string; memberId: string; sessionId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null };
let rows: Row[] = [];
const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock('@/core/config/env', () => ({ env }));
vi.mock('@/core/logger/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('web-push', () => ({ default: { sendNotification, setVapidDetails } }));
vi.mock('@/core/prisma/client', () => ({
  prisma: {
    pushSubscription: {
      findMany: vi.fn(async ({ where }: { where: { memberId: string } }) => rows.filter((r) => r.memberId === where.memberId)),
      deleteMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; endpoint?: string; memberId?: string } }) => {
        rows = rows.filter((r) =>
          where.id ? !where.id.in.includes(r.id) : !(r.endpoint === where.endpoint && r.memberId === where.memberId),
        );
      }),
      upsert: vi.fn(
        async ({ where, create, update }: { where: { endpoint: string }; create: Omit<Row, 'id'>; update: Partial<Row> }) => {
          const existing = rows.find((r) => r.endpoint === where.endpoint);
          if (existing) {
            Object.assign(existing, update);
            return { id: existing.id };
          }
          const row = { id: `p${rows.length + 1}`, ...create };
          rows.push(row);
          return { id: row.id };
        },
      ),
    },
  },
}));

const load = () => import('./push.service');
const payload = { type: 'dm:new-message' as const, conversationId: 'c1', senderName: 'Asha', body: 'hi', badgeCount: 3 };
const seed = (id: string, memberId: string) =>
  rows.push({ id, memberId, sessionId: 's1', endpoint: `https://push.example.com/${id}`, p256dh: 'k', auth: 'a', userAgent: null });

beforeEach(() => {
  vi.resetModules();
  rows = [];
  sendNotification.mockReset();
  setVapidDetails.mockReset();
  env.push.vapidPublicKey = 'pub';
  env.push.vapidPrivateKey = 'priv';
});

describe('sendPushToMember', () => {
  it('does nothing when the VAPID keys are not set', async () => {
    env.push.vapidPrivateKey = '';
    seed('p1', 'm1');
    const { sendPushToMember } = await load();
    await sendPushToMember('m1', payload);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends the payload to every subscription the member has, and only theirs', async () => {
    seed('p1', 'm1');
    seed('p2', 'm1');
    seed('p3', 'm2');
    const { sendPushToMember } = await load();
    await sendPushToMember('m1', payload);
    expect(setVapidDetails).toHaveBeenCalledWith('https://app.example.com', 'pub', 'priv');
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0][1]).toBe(JSON.stringify(payload));
    expect(sendNotification.mock.calls[0][2]).toEqual({ TTL: 86400 });
  });

  it('deletes subscriptions the push service reports gone (404/410) and keeps the rest', async () => {
    seed('gone410', 'm1');
    seed('gone404', 'm1');
    seed('flaky', 'm1');
    seed('fine', 'm1');
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('gone410')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (sub.endpoint.endsWith('gone404')) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      if (sub.endpoint.endsWith('flaky')) throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
    });
    const { sendPushToMember } = await load();
    await expect(sendPushToMember('m1', payload)).resolves.toBeUndefined();
    expect(rows.map((r) => r.id).sort()).toEqual(['fine', 'flaky']);
  });

  it('never throws, even when the database does', async () => {
    const { prisma } = await import('@/core/prisma/client');
    vi.mocked(prisma.pushSubscription.findMany).mockRejectedValueOnce(new Error('db down'));
    const { sendPushToMember } = await load();
    await expect(sendPushToMember('m1', payload)).resolves.toBeUndefined();
  });
});

describe('subscribe / unsubscribe', () => {
  const sub = { endpoint: 'https://push.example.com/shared', keys: { p256dh: 'k1', auth: 'a1' } };

  it('upserts on the endpoint, moving the row to whoever subscribed last', async () => {
    const { subscribe } = await load();
    const first = await subscribe('m1', 's1', sub, 'UA');
    const second = await subscribe('m2', 's2', { ...sub, keys: { p256dh: 'k2', auth: 'a2' } });
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: 'm2', sessionId: 's2', p256dh: 'k2', auth: 'a2', userAgent: null });
  });

  it("only removes the caller's own row", async () => {
    const { subscribe, unsubscribe } = await load();
    await subscribe('m1', 's1', sub);
    await unsubscribe('m2', sub.endpoint);
    expect(rows).toHaveLength(1);
    await unsubscribe('m1', sub.endpoint);
    expect(rows).toHaveLength(0);
  });
});

describe('vapidPublicKey', () => {
  it('is empty unless both halves of the pair are set', async () => {
    expect((await load()).vapidPublicKey()).toBe('pub');
    env.push.vapidPrivateKey = '';
    expect((await load()).vapidPublicKey()).toBe('');
  });
});
