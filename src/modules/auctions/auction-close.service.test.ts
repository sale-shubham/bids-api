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
};
const state = vi.hoisted(() => ({
  auctions: [] as any[],
  commissions: [] as any[],
  members: {} as Record<string, any>,
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const publish = vi.hoisted(() => vi.fn(async (_e: unknown) => undefined));

vi.mock('@/core/config/env', () => ({ env: { commission: { rateBps: 500 } } }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/settings/settings.service', () => ({ getSetting: async () => null }));
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
  ...over,
});

beforeEach(() => {
  enqueue.mockClear();
  publish.mockClear();
  state.commissions = [];
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
});
