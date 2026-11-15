import { beforeEach, describe, expect, it, vi } from 'vitest';

type A = {
  id: string;
  status: string;
  startTime: Date;
  endTime: Date;
  deletedAt: Date | null;
  endedAt: Date | null;
  sellerId: string;
  highestBidderId: string | null;
  winnerId: string | null;
  bidCount: number;
  currentBidPaise: number;
  reservePricePaise: number | null;
};
const state = vi.hoisted(() => ({
  auctions: [] as any[],
  commissions: [] as any[],
  members: {} as Record<string, any>,
  sales: [] as any[],
  payout: {} as Record<string, string>,
  mode: null as string | null,
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const publish = vi.hoisted(() => vi.fn(async (_e: unknown) => undefined));

vi.mock('@/core/config/env', () => ({ env: { commission: { rateBps: 500 } } }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/settings/settings.service', () => ({ getSetting: async (k: string) => (k === 'checkout.mode' ? state.mode : null) }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('./auction-events', () => ({ publishAuctionEvent: publish }));
vi.mock('@/core/prisma/client', () => {
  const tx = {
    auction: {
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        const hit = state.auctions.filter(
          (a: A) =>
            (!where.id || a.id === where.id) &&
            (!where.status?.in || where.status.in.includes(a.status)) &&
            (typeof where.status !== 'string' || a.status === where.status) &&
            (!where.endTime?.lte || a.endTime <= where.endTime.lte) &&
            (!where.endTime?.gt || a.endTime > where.endTime.gt) &&
            (!where.startTime?.lte || a.startTime <= where.startTime.lte) &&
            a.deletedAt === null,
        );
        hit.forEach((a: A) => Object.assign(a, data));
        return { count: hit.length };
      },
      findMany: async ({ where, take }: { where: any; take: number }) =>
        state.auctions
          .filter((a: A) => where.status.in.includes(a.status) && a.endTime <= where.endTime.lte && a.deletedAt === null)
          .slice(0, take)
          .map((a: A) => ({ id: a.id })),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => state.auctions.find((a: A) => a.id === where.id),
      update: async ({ where, data }: { where: { id: string }; data: any }) =>
        Object.assign(state.auctions.find((a: A) => a.id === where.id), data),
    },
    commission: { create: async ({ data }: { data: any }) => void state.commissions.push(data) },
    sale: {
      create: async ({ data }: { data: any }) => {
        const row = { id: `sale${state.sales.length + 1}`, ...data };
        state.sales.push(row);
        return { id: row.id };
      },
    },
    sellerPayoutAccount: {
      findUnique: async ({ where }: { where: { sellerId: string } }) =>
        state.payout[where.sellerId] ? { status: state.payout[where.sellerId] } : null,
    },
    member: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, { increment: number }> }) => {
        const m = state.members[where.id];
        for (const [k, v] of Object.entries(data)) m[k] += v.increment;
      },
    },
  };
  return { prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

import { runAuctionClose } from './auction-close.service';

const now = new Date('2026-11-14T10:00:00Z');
const mk = (id: string, over: Partial<A>): A => ({
  id,
  status: 'LIVE',
  startTime: new Date(now.getTime() - 7200_000),
  endTime: new Date(now.getTime() - 1000),
  deletedAt: null,
  endedAt: null,
  sellerId: 's1',
  highestBidderId: null,
  winnerId: null,
  bidCount: 0,
  currentBidPaise: 0,
  reservePricePaise: null,
  ...over,
});

beforeEach(() => {
  enqueue.mockClear();
  publish.mockClear();
  state.commissions = [];
  state.sales = [];
  state.payout = {};
  state.mode = null;
  state.members = {
    s1: { unpaidCommissionPaise: 0, auctionsWon: 0, moneySpentPaise: 0 },
    w1: { unpaidCommissionPaise: 0, auctionsWon: 0, moneySpentPaise: 0 },
  };
  state.auctions = [
    mk('sold', { highestBidderId: 'w1', bidCount: 3, currentBidPaise: 12_350 }),
    mk('unsold', {}),
    mk('future', { status: 'SCHEDULED', startTime: new Date(now.getTime() + 3600_000), endTime: new Date(now.getTime() + 7200_000) }),
    mk('toStart', { status: 'SCHEDULED', startTime: new Date(now.getTime() - 1000), endTime: new Date(now.getTime() + 7200_000) }),
  ];
});

describe('runAuctionClose', () => {
  it('starts due auctions, closes ended ones, books commission and stats', async () => {
    const counts = await runAuctionClose(now);
    expect(counts).toEqual({ started: 1, ended: 2, sold: 1, unsold: 1 });
    const sold = state.auctions.find((a: A) => a.id === 'sold');
    expect([sold.status, sold.winnerId, sold.endedAt]).toEqual(['ENDED', 'w1', now]);
    expect(state.commissions).toHaveLength(1);
    expect(state.commissions[0]).toMatchObject({ auctionId: 'sold', rateBps: 500, amountPaise: 618 });
    expect(state.members.s1.unpaidCommissionPaise).toBe(618);
    expect(state.members.w1).toMatchObject({ auctionsWon: 1, moneySpentPaise: 12_350 });
    expect(state.auctions.find((a: A) => a.id === 'unsold').winnerId).toBeNull();
    expect(state.auctions.find((a: A) => a.id === 'toStart').status).toBe('LIVE');
    expect(state.auctions.find((a: A) => a.id === 'future').status).toBe('SCHEDULED');
    expect(enqueue.mock.calls.map((c) => (c[0] as { type: string }).type).sort()).toEqual([
      'auction-sold',
      'auction-unsold',
      'auction-won',
      'commission-due',
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('a second run is a no-op', async () => {
    await runAuctionClose(now);
    enqueue.mockClear();
    publish.mockClear();
    const again = await runAuctionClose(now);
    expect(again).toEqual({ started: 0, ended: 0, sold: 0, unsold: 0 });
    expect(state.commissions).toHaveLength(1);
    expect(state.members.s1.unpaidCommissionPaise).toBe(618);
    expect(state.members.w1.auctionsWon).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  describe('hidden reserve', () => {
    it('reserve not met: no winner, no commission, no member stats; reserve-not-met + unsold notifications', async () => {
      state.auctions = [mk('low', { highestBidderId: 'w1', bidCount: 3, currentBidPaise: 40_000, reservePricePaise: 50_000 })];
      const counts = await runAuctionClose(now);
      expect(counts).toEqual({ started: 0, ended: 1, sold: 0, unsold: 1 });
      const a = state.auctions[0];
      expect([a.status, a.winnerId]).toEqual(['ENDED', null]);
      expect(state.commissions).toHaveLength(0);
      expect(state.members.s1.unpaidCommissionPaise).toBe(0);
      expect(state.members.w1).toMatchObject({ auctionsWon: 0, moneySpentPaise: 0 });
      const sent = enqueue.mock.calls.map((c) => c[0] as { type: string; memberId: string; data?: unknown; dedupeKey: string });
      expect(sent.map((m) => m.type).sort()).toEqual(['auction-unsold', 'reserve-not-met']);
      expect(sent.find((m) => m.type === 'auction-unsold')).toMatchObject({
        memberId: 's1',
        data: { reserveNotMet: true },
      });
      expect(sent.find((m) => m.type === 'reserve-not-met')).toMatchObject({
        memberId: 'w1',
        dedupeKey: `reserve-not-met:low:${now.getTime()}`,
      });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'auction.ended', winnerId: null, finalBidPaise: 0, bidCount: 3 }));
    });

    it('reserve met (or exactly reached): sold as before', async () => {
      state.auctions = [mk('ok', { highestBidderId: 'w1', bidCount: 3, currentBidPaise: 50_000, reservePricePaise: 50_000 })];
      expect(await runAuctionClose(now)).toEqual({ started: 0, ended: 1, sold: 1, unsold: 0 });
      expect(state.auctions[0].winnerId).toBe('w1');
      expect(state.commissions).toHaveLength(1);
      expect(state.members.w1).toMatchObject({ auctionsWon: 1, moneySpentPaise: 50_000 });
      expect(enqueue.mock.calls.map((c) => (c[0] as { type: string }).type).sort()).toEqual([
        'auction-sold',
        'auction-won',
        'commission-due',
      ]);
    });

    it('no bids with a reserve: plain unsold, no reserve-not-met', async () => {
      state.auctions = [mk('none', { reservePricePaise: 50_000 })];
      await runAuctionClose(now);
      const sent = enqueue.mock.calls.map((c) => c[0] as { type: string; data?: unknown });
      expect(sent.map((m) => m.type)).toEqual(['auction-unsold']);
      expect(sent[0].data).toBeUndefined();
    });
  });
});

describe('checkout (sale) mode', () => {
  const soldOnly = () => {
    state.auctions = [mk('sold', { highestBidderId: 'w1', bidCount: 3, currentBidPaise: 12_350 })];
  };
  const types = () => enqueue.mock.calls.map((c) => (c[0] as { type: string }).type).sort();

  it("optional + ACTIVE payout account: a Sale replaces the Commission and the unpaid counter", async () => {
    soldOnly();
    state.mode = 'optional';
    state.payout = { s1: 'ACTIVE' };
    expect(await runAuctionClose(now)).toEqual({ started: 0, ended: 1, sold: 1, unsold: 0 });
    expect(state.commissions).toHaveLength(0);
    expect(state.members.s1.unpaidCommissionPaise).toBe(0);
    expect(state.members.w1).toMatchObject({ auctionsWon: 1, moneySpentPaise: 12_350 });
    expect(state.sales).toHaveLength(1);
    expect(state.sales[0]).toMatchObject({
      auctionId: 'sold',
      buyerId: 'w1',
      sellerId: 's1',
      itemPaise: 12_350,
      shippingFeePaise: 0,
      amountPaise: 12_350,
      commissionPaise: 618,
      rateBps: 500,
      payBy: new Date(now.getTime() + 3 * 86_400_000),
    });
    expect(types()).toEqual(['auction-sold', 'auction-won']);
    const sent = enqueue.mock.calls.map((c) => c[0] as { type: string; data: Record<string, unknown> });
    expect(sent.find((m) => m.type === 'auction-won')!.data).toMatchObject({ saleId: 'sale1', payBy: new Date(now.getTime() + 3 * 86_400_000).toISOString() });
    expect(sent.find((m) => m.type === 'auction-sold')!.data).toMatchObject({ checkout: true, saleId: 'sale1' });
  });

  it('required behaves like optional at close time', async () => {
    soldOnly();
    state.mode = 'required';
    state.payout = { s1: 'ACTIVE' };
    await runAuctionClose(now);
    expect(state.sales).toHaveLength(1);
    expect(state.commissions).toHaveLength(0);
  });

  it('off: legacy commission flow even with an ACTIVE payout account', async () => {
    soldOnly();
    state.mode = 'off';
    state.payout = { s1: 'ACTIVE' };
    await runAuctionClose(now);
    expect(state.sales).toHaveLength(0);
    expect(state.commissions).toHaveLength(1);
    expect(state.members.s1.unpaidCommissionPaise).toBe(618);
  });

  it.each(['PENDING', 'NEEDS_CLARIFICATION', 'SUSPENDED', 'REJECTED', undefined])(
    'optional + payout account %s: legacy commission flow',
    async (status) => {
      soldOnly();
      state.mode = 'optional';
      if (status) state.payout = { s1: status };
      await runAuctionClose(now);
      expect(state.sales).toHaveLength(0);
      expect(state.commissions).toHaveLength(1);
      expect(types()).toEqual(['auction-sold', 'auction-won', 'commission-due']);
    },
  );

  it('a Buy It Now style close (closeOneTx with a mode) uses the same path', async () => {
    soldOnly();
    state.payout = { s1: 'ACTIVE' };
    const { prisma } = await import('@/core/prisma/client');
    const { closeOneTx } = await import('./auction-close.service');
    const closed = await (prisma as any).$transaction((tx: any) => closeOneTx(tx, 'sold', now, 500, 'optional'));
    expect(closed).toMatchObject({ sold: true, saleId: 'sale1' });
    expect(state.commissions).toHaveLength(0);
  });
});
