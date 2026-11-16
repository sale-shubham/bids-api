import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  member: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountPaise: null } })), groupBy: vi.fn(async () => [] as unknown[]) },
  auction: { count: vi.fn(), findMany: vi.fn() },
  bid: { count: vi.fn() },
  commission: { aggregate: vi.fn(), findMany: vi.fn() },
  sale: { groupBy: vi.fn(async () => [] as unknown[]) },
}));
const disconnect = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/ws/ws.service', () => ({ disconnectMemberConnections: disconnect }));

import { assertManageable, listMembers, getMemberStats, updateMember } from './members/admin-members.service';
import { listMembersQuery, updateMemberBody } from './members/admin-members.validation';
import { getDashboard, lastMonths, revenueSeries, signupSeries } from './dashboard/admin-dashboard.service';

beforeEach(() => vi.clearAllMocks());

describe('admin members hide super admins', () => {
  it('listMembers always excludes SUPER_ADMIN, even with role / status / search filters', async () => {
    db.member.findMany.mockResolvedValue([]);
    db.member.count.mockResolvedValue(0);
    await listMembers({ page: 1, pageSize: 20 });
    await listMembers({ page: 1, pageSize: 20, role: 'BIDDER', status: 'active', search: 'admin' });
    const wheres = db.member.findMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) expect(w.AND).toEqual([{ role: { not: 'SUPER_ADMIN' } }]);
    expect(wheres[1].role).toBe('BIDDER');
  });

  it('stats tabs exclude SUPER_ADMIN', async () => {
    db.member.count.mockResolvedValue(1);
    await getMemberStats();
    for (const c of db.member.count.mock.calls) expect(c[0].where.role).toEqual({ not: 'SUPER_ADMIN' });
  });

  it('list role filter accepts BIDDER / AUCTIONEER only', () => {
    expect(listMembersQuery.validate({ role: 'BIDDER' }).error).toBeUndefined();
    expect(listMembersQuery.validate({ role: 'AUCTIONEER' }).error).toBeUndefined();
    expect(listMembersQuery.validate({ role: 'SUPER_ADMIN' }).error).toBeDefined();
  });

  it('updateMember 404s on a SUPER_ADMIN target; the self guard still wins', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'sa', role: 'SUPER_ADMIN' });
    await expect(updateMember('sa', 'me', { isActive: false })).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateMember('me', 'me', { role: 'BIDDER' })).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('role change accepts BIDDER / AUCTIONEER only; SUPER_ADMIN is rejected by validation', () => {
    expect(updateMemberBody.validate({ role: 'BIDDER' }).error).toBeUndefined();
    expect(updateMemberBody.validate({ role: 'AUCTIONEER' }).error).toBeUndefined();
    expect(updateMemberBody.validate({ role: 'SUPER_ADMIN' }).error).toBeDefined();
  });

  it('assertManageable 404s for SUPER_ADMIN, passes for others and unknown ids', async () => {
    db.member.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
    await expect(assertManageable('sa')).rejects.toMatchObject({ statusCode: 404 });
    db.member.findUnique.mockResolvedValue({ role: 'BIDDER' });
    await expect(assertManageable('b')).resolves.toBeUndefined();
    db.member.findUnique.mockResolvedValue(null);
    await expect(assertManageable('nope')).resolves.toBeUndefined();
  });
});

describe('admin member self-protection', () => {
  it('409 CANNOT_MODIFY_SELF when changing own role or deactivating self', async () => {
    await expect(updateMember('me', 'me', { role: 'BIDDER' })).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_MODIFY_SELF' });
    await expect(updateMember('me', 'me', { isActive: false })).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('deactivating another member revokes sessions and disconnects sockets', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'x' });
    db.member.update.mockResolvedValue({ id: 'x', isActive: false, unpaidCommissionPaise: 0n, moneySpentPaise: 0n });
    const out = await updateMember('x', 'me', { isActive: false });
    expect(out).toMatchObject({ id: 'x', isActive: false });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'x' } });
    expect(disconnect).toHaveBeenCalledWith('x');
  });

  it('the admin DTO carries activeStrikes (not-removed, unexpired) and drops the raw _count', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'x' });
    db.member.update.mockResolvedValue({ id: 'x', isActive: true, unpaidCommissionPaise: 0n, moneySpentPaise: 0n, _count: { strikes: 2 } });
    const out = (await updateMember('x', 'me', { isActive: true })) as Record<string, unknown>;
    expect(out.activeStrikes).toBe(2);
    expect(out).not.toHaveProperty('_count');
    const select = db.member.update.mock.calls.at(-1)![0].select;
    expect(select._count.select.strikes.where).toMatchObject({ removedAt: null, expiresAt: { gt: expect.any(Date) } });
  });

  it('404 for unknown member; reactivation does not revoke sessions', async () => {
    db.member.findUnique.mockResolvedValue(null);
    await expect(updateMember('nope', 'me', { isActive: true })).rejects.toMatchObject({ statusCode: 404 });
    db.member.findUnique.mockResolvedValue({ id: 'x' });
    db.member.update.mockResolvedValue({ id: 'x', isActive: true, unpaidCommissionPaise: 0n, moneySpentPaise: 0n });
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

  it('getDashboard converts bigint _sum / rows to numbers', async () => {
    db.member.count.mockResolvedValue(0);
    db.auction.count.mockResolvedValue(0);
    db.bid.count.mockResolvedValue(0);
    db.commission.aggregate
      .mockResolvedValueOnce({ _sum: { amountPaise: 3_000_000_000n } })
      .mockResolvedValueOnce({ _sum: { amountPaise: 7n } });
    db.commission.findMany.mockResolvedValue([{ amountPaise: 3_000_000_000n, paidAt: new Date('2026-11-02T00:00:00Z') }]);
    db.member.findMany.mockResolvedValue([]);
    db.auction.findMany.mockResolvedValue([]);
    db.sale.groupBy.mockResolvedValue([
      { status: 'PAID', _count: { _all: 2 }, _sum: { amountPaise: 5_000_000_000n } },
      { status: 'RELEASED', _count: { _all: 1 }, _sum: { amountPaise: 100n } },
    ]);
    const d = await getDashboard(now);
    expect(d.salesByStatus.PAID).toEqual({ count: 2, amountPaise: 5_000_000_000 });
    expect(d.salesByStatus.RELEASED).toEqual({ count: 1, amountPaise: 100 });
    expect(d.salesByStatus.DISPUTED).toEqual({ count: 0, amountPaise: 0 });
    expect(d.totals.commissionPaidPaise).toBe(3_000_000_000);
    expect(d.totals.commissionDuePaise).toBe(7);
    expect(d.revenueByMonth.at(-1)!.paidPaise).toBe(3_000_000_000);
    expect(() => JSON.stringify(d)).not.toThrow();
  });

  it('getDashboard members total excludes SUPER_ADMIN', async () => {
    db.member.count.mockResolvedValue(0);
    db.auction.count.mockResolvedValue(0);
    db.bid.count.mockResolvedValue(0);
    db.commission.aggregate.mockResolvedValue({ _sum: { amountPaise: null } });
    db.commission.findMany.mockResolvedValue([]);
    db.member.findMany.mockResolvedValue([]);
    db.auction.findMany.mockResolvedValue([]);
    await getDashboard(now);
    const wheres = db.member.count.mock.calls.map((c) => c[0]?.where);
    expect(wheres).toContainEqual({ role: { not: 'SUPER_ADMIN' } });
    expect(wheres).not.toContain(undefined);
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
