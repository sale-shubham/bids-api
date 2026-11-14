import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  commissions: [] as any[],
  orders: [] as any[],
  members: {} as Record<string, any>,
  seq: 0,
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const provider = vi.hoisted(() => ({
  publicKey: 'rzp_test_key',
  createOrder: vi.fn(),
}));

vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/core/prisma/client', () => {
  const db: any = {
    commission: {
      findFirst: async ({ where }: any) =>
        state.commissions.find((c) => c.id === where.id && c.sellerId === where.sellerId) ?? null,
      findUnique: async ({ where }: any) => state.commissions.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        state.commissions.filter(
          (c) =>
            c.status === where.status &&
            (c.dueAt < where.OR[0].dueAt.lt || c.createdAt <= where.OR[1].createdAt.lte),
        ),
      updateMany: async ({ where, data }: any) => {
        const hit = state.commissions.filter((c) => c.id === where.id && (!where.status || c.status === where.status));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      },
    },
    member: { findUnique: async ({ where }: any) => state.members[where.id] ?? null },
    paymentOrder: {
      findFirst: async ({ where }: any) =>
        state.orders.find(
          (o) =>
            o.memberId === where.memberId &&
            o.referenceId === where.referenceId &&
            o.status === where.status &&
            o.amountPaise === where.amountPaise &&
            o.createdAt >= where.createdAt.gte,
        ) ?? null,
      findUnique: async ({ where }: any) => state.orders.find((o) => o.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const o = { id: `po${++state.seq}`, status: 'CREATED', createdAt: new Date(), gatewayPaymentId: null, ...data };
        state.orders.push(o);
        return o;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = state.orders.filter((o) => o.id === where.id && (!where.status?.not || o.status !== where.status.not));
        hit.forEach((o) => Object.assign(o, data));
        return { count: hit.length };
      },
    },
    // GREATEST(0, unpaid - amount), values arrive as template params [amount, memberId].
    $executeRaw: async (_q: TemplateStringsArray, amount: number, memberId: string) => {
      const m = state.members[memberId];
      m.unpaidCommissionPaise = Math.max(0, m.unpaidCommissionPaise - amount);
      return 1;
    },
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { prisma: db };
});

import { checkout, getMine, markCommissionPaid, runCommissionReminders, waiveCommission } from './commissions.service';

const NOW = new Date('2026-11-20T10:00:00Z');
const commission = (over: Record<string, unknown> = {}) => ({
  id: 'c1_abcdefghijklmnop',
  sellerId: 'm1',
  auctionId: 'a1',
  amountPaise: 50_000,
  status: 'DUE',
  dueAt: new Date('2026-11-27T00:00:00Z'),
  paidAt: null,
  createdAt: new Date('2026-11-20T00:00:00Z'),
  rateBps: 500,
  auction: { id: 'a1', title: 'Vintage Watch', images: ['x.jpg'], currentBidPaise: 1_000_000, endedAt: NOW },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.commissions = [commission()];
  state.orders = [];
  state.seq = 0;
  state.members = {
    m1: { id: 'm1', name: 'Asha', email: 'a@x.com', phone: '9999999999', unpaidCommissionPaise: 50_000 },
    m2: { id: 'm2', name: 'Bob', email: 'b@x.com', phone: null, unpaidCommissionPaise: 0 },
  };
  let n = 0;
  provider.createOrder.mockImplementation(async () => ({ gatewayOrderId: `order_${++n}`, keyId: 'rzp_test_key' }));
});

describe('checkout', () => {
  it('creates a gateway order with receipt <= 40 chars and notes', async () => {
    const r = await checkout('m1', 'c1_abcdefghijklmnop', NOW);
    expect(r).toMatchObject({
      orderId: 'order_1',
      amountPaise: 50_000,
      currency: 'INR',
      keyId: 'rzp_test_key',
      prefill: { name: 'Asha', email: 'a@x.com', contact: '9999999999' },
    });
    const arg = provider.createOrder.mock.calls[0][0];
    expect(arg.amountPaise).toBe(50_000);
    expect(arg.receipt.length).toBeLessThanOrEqual(40);
    expect(arg.notes).toEqual({ commissionId: 'c1_abcdefghijklmnop', memberId: 'm1' });
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ referenceType: 'COMMISSION', status: 'CREATED' });
  });

  it('reuses a CREATED order younger than 30 min', async () => {
    const first = await checkout('m1', 'c1_abcdefghijklmnop', NOW);
    state.orders[0].createdAt = new Date(NOW.getTime() - 10 * 60_000);
    const second = await checkout('m1', 'c1_abcdefghijklmnop', NOW);
    expect(second.orderId).toBe(first.orderId);
    expect(provider.createOrder).toHaveBeenCalledOnce();
  });

  it('creates a new order when the previous one is older than 30 min', async () => {
    await checkout('m1', 'c1_abcdefghijklmnop', NOW);
    state.orders[0].createdAt = new Date(NOW.getTime() - 31 * 60_000);
    const second = await checkout('m1', 'c1_abcdefghijklmnop', NOW);
    expect(second.orderId).toBe('order_2');
    expect(provider.createOrder).toHaveBeenCalledTimes(2);
  });

  it('404 COMMISSION_NOT_FOUND for a non-owner', async () => {
    await expect(checkout('m2', 'c1_abcdefghijklmnop', NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMISSION_NOT_FOUND',
    });
  });

  it('409 COMMISSION_NOT_DUE when already paid', async () => {
    state.commissions[0].status = 'PAID';
    await expect(checkout('m1', 'c1_abcdefghijklmnop', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMISSION_NOT_DUE',
    });
  });
});

describe('getMine', () => {
  it('returns the DTO for the owner', async () => {
    const dto = await getMine('m1', 'c1_abcdefghijklmnop', NOW);
    expect(dto).toMatchObject({ id: 'c1_abcdefghijklmnop', status: 'DUE', amountPaise: 50_000, isOverdue: false });
    expect(dto.auction).toMatchObject({ title: 'Vintage Watch', coverImage: 'x.jpg' });
  });

  it('404 COMMISSION_NOT_FOUND for another seller', async () => {
    await expect(getMine('m2', 'c1_abcdefghijklmnop', NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMISSION_NOT_FOUND',
    });
  });

  it('404 COMMISSION_NOT_FOUND for an unknown id', async () => {
    await expect(getMine('m1', 'nope', NOW)).rejects.toMatchObject({ statusCode: 404, code: 'COMMISSION_NOT_FOUND' });
  });
});

describe('markCommissionPaid', () => {
  const seedOrder = () => {
    state.orders.push({
      id: 'po1',
      memberId: 'm1',
      gatewayOrderId: 'order_1',
      amountPaise: 50_000,
      status: 'CREATED',
      referenceType: 'COMMISSION',
      referenceId: 'c1_abcdefghijklmnop',
      gatewayPaymentId: null,
      createdAt: NOW,
    });
  };

  it('settles once: commission PAID, order PAID, unpaid decremented, notification queued', async () => {
    seedOrder();
    const r = await markCommissionPaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, NOW);
    expect(r).toEqual({ applied: true, commissionId: 'c1_abcdefghijklmnop' });
    expect(state.commissions[0]).toMatchObject({ status: 'PAID', paidAt: NOW, paymentOrderId: 'po1' });
    expect(state.orders[0]).toMatchObject({ status: 'PAID', gatewayPaymentId: 'pay_1' });
    expect(state.members.m1.unpaidCommissionPaise).toBe(0);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: 'commission-paid',
      memberId: 'm1',
      dedupeKey: 'commission-paid:c1_abcdefghijklmnop',
    });
  });

  it('is idempotent: a second call is a no-op', async () => {
    seedOrder();
    state.members.m1.unpaidCommissionPaise = 80_000; // another commission also owed
    await markCommissionPaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, NOW);
    const second = await markCommissionPaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, NOW);
    expect(second.applied).toBe(false);
    expect(state.members.m1.unpaidCommissionPaise).toBe(30_000);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('never drives unpaid below 0', async () => {
    seedOrder();
    state.members.m1.unpaidCommissionPaise = 10_000; // drifted lower than the commission
    await markCommissionPaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, NOW);
    expect(state.members.m1.unpaidCommissionPaise).toBe(0);
  });

  it('unknown order or non-commission order is a no-op', async () => {
    expect(await markCommissionPaid({ paymentOrderId: 'nope' })).toEqual({ applied: false, commissionId: null });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('waiveCommission', () => {
  it('DUE -> WAIVED and decrements unpaid (clamped)', async () => {
    state.members.m1.unpaidCommissionPaise = 20_000;
    const dto = await waiveCommission('c1_abcdefghijklmnop', 'admin1', NOW);
    expect(dto.status).toBe('WAIVED');
    expect(state.members.m1.unpaidCommissionPaise).toBe(0);
  });

  it('409 when not DUE, 404 when missing', async () => {
    state.commissions[0].status = 'PAID';
    await expect(waiveCommission('c1_abcdefghijklmnop', 'admin1')).rejects.toMatchObject({ code: 'COMMISSION_NOT_DUE' });
    await expect(waiveCommission('zzz', 'admin1')).rejects.toMatchObject({ code: 'COMMISSION_NOT_FOUND' });
  });
});

describe('runCommissionReminders', () => {
  it('reminds overdue / 3-day-old DUE commissions with a per-day dedupeKey', async () => {
    state.commissions = [
      commission({ id: 'old', createdAt: new Date('2026-11-10T00:00:00Z'), dueAt: new Date('2026-11-17T00:00:00Z') }),
      commission({ id: 'fresh', createdAt: new Date('2026-11-20T00:00:00Z'), dueAt: new Date('2026-11-27T00:00:00Z') }),
      commission({ id: 'paid', status: 'PAID', createdAt: new Date('2026-11-01T00:00:00Z') }),
    ];
    expect(await runCommissionReminders(NOW)).toEqual({ reminded: 1 });
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: 'commission-due',
      dedupeKey: 'commission-reminder:old:2026-11-20',
    });
    await runCommissionReminders(new Date('2026-11-21T10:00:00Z'));
    expect(enqueue.mock.calls[1][0]).toMatchObject({ dedupeKey: 'commission-reminder:old:2026-11-21' });
  });
});
