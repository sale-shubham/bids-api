import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  member: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  auction: { count: vi.fn(), findMany: vi.fn() },
  bid: { count: vi.fn() },
  commission: { aggregate: vi.fn(), findMany: vi.fn() },
}));
const disconnect = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/ws/ws.service', () => ({ disconnectMemberConnections: disconnect }));

import { updateMember } from './members/admin-members.service';
import { updateMemberBody } from './members/admin-members.validation';
import { getDashboard, lastMonths, revenueSeries, signupSeries } from './dashboard/admin-dashboard.service';

beforeEach(() => vi.clearAllMocks());

describe('admin member self-protection', () => {
  it('409 CANNOT_MODIFY_SELF when changing own role or deactivating self', async () => {
    await expect(updateMember('me', 'me', { role: 'BIDDER' })).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_MODIFY_SELF' });
    await expect(updateMember('me', 'me', { isActive: false })).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('deactivating another member revokes sessions and disconnects sockets', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'x' });
    db.member.update.mockResolvedValue({ id: 'x', isActive: false });
    const out = await updateMember('x', 'me', { isActive: false });
    expect(out).toMatchObject({ id: 'x', isActive: false });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'x' } });
    expect(disconnect).toHaveBeenCalledWith('x');
  });

  it('404 for unknown member; reactivation does not revoke sessions', async () => {
    db.member.findUnique.mockResolvedValue(null);
    await expect(updateMember('nope', 'me', { isActive: true })).rejects.toMatchObject({ statusCode: 404 });
    db.member.findUnique.mockResolvedValue({ id: 'x' });
    db.member.update.mockResolvedValue({ id: 'x', isActive: true });
    await updateMember('x', 'me', { isActive: true });
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });

  it('PATCH body needs at least one valid field', () => {
    expect(updateMemberBody.validate({}).error).toBeDefined();
    expect(updateMemberBody.validate({ role: 'ROOT' }).error).toBeDefined();
    expect(updateMemberBody.validate({ isActive: true, role: 'AUCTIONEER' }).error).toBeUndefined();
  });
});

describe('dashboard zero-fill', () => {
  const now = new Date('2026-11-14T10:00:00Z');

  it('window is exactly 12 months ending this month, crossing the year boundary', () => {
    const months = lastMonths(now);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-12');
    expect(months[11]).toBe('2026-11');
  });

  it('revenue and signups fill empty months with zero and ignore out-of-window rows', () => {
    const rev = revenueSeries(
      [
        { amountPaise: 500, paidAt: new Date('2026-09-10T00:00:00Z') },
        { amountPaise: 250, paidAt: new Date('2026-09-20T00:00:00Z') },
        { amountPaise: 999, paidAt: new Date('2020-01-01T00:00:00Z') },
      ],
      now,
    );
    expect(rev).toHaveLength(12);
    expect(rev.find((r) => r.month === '2026-09')!.paidPaise).toBe(750);
    expect(rev.filter((r) => r.paidPaise === 0)).toHaveLength(11);

    const sign = signupSeries(
      [
        { role: 'BIDDER', createdAt: new Date('2026-11-01T00:00:00Z') },
        { role: 'AUCTIONEER', createdAt: new Date('2026-11-02T00:00:00Z') },
        { role: 'BIDDER', createdAt: new Date('2026-11-03T00:00:00Z') },
      ],
      now,
    );
    expect(sign).toHaveLength(12);
    expect(sign[11]).toEqual({ month: '2026-11', bidders: 2, auctioneers: 1 });
    expect(sign[0]).toEqual({ month: '2025-12', bidders: 0, auctioneers: 0 });
  });

  it('getDashboard on an empty database returns zeros and full series', async () => {
    db.member.count.mockResolvedValue(0);
    db.auction.count.mockResolvedValue(0);
    db.bid.count.mockResolvedValue(0);
    db.commission.aggregate.mockResolvedValue({ _sum: { amountPaise: null } });
    db.commission.findMany.mockResolvedValue([]);
    db.member.findMany.mockResolvedValue([]);
    db.auction.findMany.mockResolvedValue([]);
    const d = await getDashboard(now);
    expect(Object.values(d.totals).every((v) => v === 0)).toBe(true);
    expect(Object.keys(d.totals)).toEqual([
      'members',
      'bidders',
      'auctioneers',
      'liveAuctions',
      'upcomingAuctions',
      'endedAuctions',
      'bidsToday',
      'commissionPaidPaise',
      'commissionDuePaise',
    ]);
    expect(d.revenueByMonth).toHaveLength(12);
    expect(d.signupsByMonth).toHaveLength(12);
    expect(d.recentAuctions).toEqual([]);
  });
});
