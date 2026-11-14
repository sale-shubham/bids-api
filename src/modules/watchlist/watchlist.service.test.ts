import { beforeEach, describe, expect, it, vi } from 'vitest';

type WRow = { memberId: string; auctionId: string; createdAt: Date; endingSoonNotifiedAt: Date | null };
const state = vi.hoisted(() => ({ rows: [] as any[], auctions: {} as Record<string, any> }));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));

vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/core/prisma/client', () => ({
  prisma: {
    auction: { findUnique: async ({ where }: any) => state.auctions[where.id] ?? null },
    watchlist: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const k = where.memberId_auctionId;
        const hit = state.rows.find((r: WRow) => r.memberId === k.memberId && r.auctionId === k.auctionId);
        if (hit) return hit;
        const row = { ...create, createdAt: new Date(), endingSoonNotifiedAt: null };
        state.rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = state.rows.length;
        state.rows = state.rows.filter((r: WRow) => !(r.memberId === where.memberId && r.auctionId === where.auctionId));
        return { count: before - state.rows.length };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const a = where.auction;
        return state.rows
          .filter((r: WRow) => {
            const au = state.auctions[r.auctionId];
            return (
              r.endingSoonNotifiedAt === null &&
              au.endTime > a.endTime.gt &&
              au.endTime <= a.endTime.lte &&
              au.startTime <= a.startTime.lte &&
              !['CANCELLED', 'ENDED'].includes(au.status)
            );
          })
          .map((r: WRow) => ({ ...r, auction: { endTime: state.auctions[r.auctionId].endTime } }));
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = state.rows.filter(
          (r: WRow) =>
            (where.memberId === undefined || r.memberId === where.memberId) &&
            r.auctionId === where.auctionId &&
            (where.endingSoonNotifiedAt === undefined || r.endingSoonNotifiedAt === where.endingSoonNotifiedAt),
        );
        hit.forEach((r: WRow) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
  },
}));

import * as svc from './watchlist.service';

const H = 3600_000;
const now = new Date('2026-11-14T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const auction = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  status: 'LIVE',
  deletedAt: null,
  startTime: at(-5 * H),
  endTime: at(10 * H),
  ...o,
});

beforeEach(() => {
  state.rows = [];
  state.auctions = {};
  enqueue.mockClear();
});

describe('watch / unwatch', () => {
  it('is idempotent: watching twice keeps one row and succeeds both times', async () => {
    state.auctions.a1 = auction('a1');
    expect(await svc.addToWatchlist('m1', 'a1')).toEqual({ watching: true });
    expect(await svc.addToWatchlist('m1', 'a1')).toEqual({ watching: true });
    expect(state.rows).toHaveLength(1);
  });
  it('404 AUCTION_NOT_FOUND for unknown or cancelled auctions', async () => {
    state.auctions.c1 = auction('c1', { status: 'CANCELLED' });
    await expect(svc.addToWatchlist('m1', 'nope')).rejects.toMatchObject({ statusCode: 404, code: 'AUCTION_NOT_FOUND' });
    await expect(svc.addToWatchlist('m1', 'c1')).rejects.toMatchObject({ code: 'AUCTION_NOT_FOUND' });
  });
  it('unwatch is idempotent too', async () => {
    state.auctions.a1 = auction('a1');
    await svc.addToWatchlist('m1', 'a1');
    expect(await svc.removeFromWatchlist('m1', 'a1')).toEqual({ watching: false });
    expect(await svc.removeFromWatchlist('m1', 'a1')).toEqual({ watching: false });
    expect(state.rows).toHaveLength(0);
  });
});

describe('sortWatched', () => {
  const row = (id: string, startMs: number, endMs: number, status = 'LIVE') => ({
    createdAt: now,
    auction: { id, status, deletedAt: null, startTime: at(startMs), endTime: at(endMs) } as any,
  });
  it('live/upcoming first by endTime asc, then ended newest first, cancelled hidden', () => {
    const sorted = svc.sortWatched(
      [
        row('ended-old', -10 * H, -5 * H, 'ENDED'),
        row('live-late', -H, 9 * H),
        row('cancelled', -H, 3 * H, 'CANCELLED'),
        row('upcoming', H, 5 * H, 'SCHEDULED'),
        row('ended-new', -10 * H, -H, 'ENDED'),
        row('live-soon', -H, 2 * H),
      ],
      now,
    );
    expect(sorted.map((r) => r.auction.id)).toEqual(['live-soon', 'upcoming', 'live-late', 'ended-new', 'ended-old']);
  });
});

describe('runEndingSoon', () => {
  beforeEach(() => {
    state.auctions.soon = auction('soon', { endTime: at(30 * 60_000) });
    state.auctions.far = auction('far', { endTime: at(3 * H) });
    state.auctions.over = auction('over', { endTime: at(-60_000) });
    state.auctions.upcoming = auction('upcoming', { status: 'SCHEDULED', startTime: at(10 * 60_000), endTime: at(2 * H) });
    for (const id of ['soon', 'far', 'over', 'upcoming']) {
      state.rows.push({ memberId: 'm1', auctionId: id, createdAt: now, endingSoonNotifiedAt: null });
    }
  });

  it('selects only live auctions ending within 60 minutes and enqueues ending-soon', async () => {
    expect(await svc.runEndingSoon(now)).toEqual({ notified: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: 'ending-soon',
      memberId: 'm1',
      auctionId: 'soon',
      dedupeKey: `ending-soon:soon:m1:${state.auctions.soon.endTime.getTime()}`,
    });
    expect(state.rows.find((r: WRow) => r.auctionId === 'soon')!.endingSoonNotifiedAt).toEqual(now);
  });

  it('is deduped: a second run notifies nobody', async () => {
    await svc.runEndingSoon(now);
    enqueue.mockClear();
    expect(await svc.runEndingSoon(at(60_000))).toEqual({ notified: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('republish reset clears endingSoonNotifiedAt so watchers are reminded again', async () => {
    await svc.runEndingSoon(now);
    await svc.resetEndingSoon('soon');
    expect(state.rows.find((r: WRow) => r.auctionId === 'soon')!.endingSoonNotifiedAt).toBeNull();
    expect(await svc.runEndingSoon(at(60_000))).toEqual({ notified: 1 });
  });
});
