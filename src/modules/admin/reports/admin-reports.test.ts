import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  report: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  auction: { findMany: vi.fn() },
  member: { findMany: vi.fn() },
  review: { findMany: vi.fn() },
  auctionQuestion: { findMany: vi.fn() },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { listReports, priorityFor, resolveReport } from './admin-reports.service';

const reporter = { id: 'u1', name: 'Rita', email: 'rita@x.test' };
const row = (id: string, targetType: string, targetId: string, extra: Record<string, unknown> = {}) => ({
  id,
  targetType,
  targetId,
  reason: 'SPAM',
  details: null,
  status: 'OPEN',
  createdAt: new Date('2026-11-14T00:00:00Z'),
  resolvedAt: null,
  note: null,
  reporter,
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.auction.findMany.mockResolvedValue([]);
  db.member.findMany.mockResolvedValue([]);
  db.review.findMany.mockResolvedValue([]);
  db.auctionQuestion.findMany.mockResolvedValue([]);
});

describe('priorityFor', () => {
  it('HIGH from 3 open reports on the same target', () => {
    expect(priorityFor(0)).toBe('NORMAL');
    expect(priorityFor(2)).toBe('NORMAL');
    expect(priorityFor(3)).toBe('HIGH');
    expect(priorityFor(10)).toBe('HIGH');
  });
});

describe('listReports', () => {
  it('maps targets, reporter, openCountForTarget and priority', async () => {
    db.report.findMany.mockResolvedValue([
      row('r1', 'AUCTION', 'a1'),
      row('r2', 'MEMBER', 'm9'),
      row('r3', 'REVIEW', 'rv1'),
      row('r4', 'QUESTION', 'q1'),
      row('r5', 'AUCTION', 'gone'),
    ]);
    db.report.count.mockResolvedValue(5);
    db.report.groupBy.mockResolvedValue([
      { targetType: 'AUCTION', targetId: 'a1', _count: { _all: 3 } },
      { targetType: 'MEMBER', targetId: 'm9', _count: { _all: 1 } },
    ]);
    db.auction.findMany.mockResolvedValue([{ id: 'a1', title: 'Vintage Watch' }]);
    db.member.findMany.mockResolvedValue([{ id: 'm9', name: 'Bad Seller' }]);
    db.review.findMany.mockResolvedValue([{ id: 'rv1', comment: 'x'.repeat(200) }]);
    db.auctionQuestion.findMany.mockResolvedValue([{ id: 'q1', auctionId: 'a7', question: 'Is it real?' }]);

    const { items, meta } = await listReports({ page: 1, pageSize: 20 });
    expect(meta).toEqual({ total: 5, page: 1, pageSize: 20, totalPages: 1 });
    expect(items[0]).toMatchObject({
      id: 'r1',
      reporter,
      target: { label: 'Vintage Watch', url: '/auctions/a1' },
      openCountForTarget: 3,
      priority: 'HIGH',
      createdAt: '2026-11-14T00:00:00.000Z',
      resolvedAt: null,
    });
    expect(items[1]).toMatchObject({ target: { label: 'Bad Seller', url: '/sellers/m9' }, openCountForTarget: 1, priority: 'NORMAL' });
    expect(items[2].target.label.length).toBeLessThanOrEqual(80);
    expect(items[3].target).toEqual({ label: 'Is it real?', url: '/auctions/a7' });
    expect(items[4]).toMatchObject({ target: { label: '(removed)', url: null }, openCountForTarget: 0, priority: 'NORMAL' });
  });

  it('passes the status / targetType filters and offset paging', async () => {
    db.report.findMany.mockResolvedValue([]);
    db.report.count.mockResolvedValue(0);
    await listReports({ status: 'OPEN', targetType: 'AUCTION', page: 3, pageSize: 10 });
    expect(db.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'OPEN', targetType: 'AUCTION' }, skip: 20, take: 10 }),
    );
    expect(db.report.groupBy).not.toHaveBeenCalled();
  });
});

describe('resolveReport', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  beforeEach(() => {
    db.report.findUnique.mockResolvedValue({ id: 'r1', status: 'OPEN', targetType: 'AUCTION', targetId: 'a1' });
    db.report.updateMany.mockResolvedValue({ count: 1 });
  });

  it('resolves just this report by default', async () => {
    const out = await resolveReport('r1', 'admin1', { status: 'DISMISSED', note: 'not an issue' }, now);
    expect(db.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'OPEN' },
      data: { status: 'DISMISSED', resolvedById: 'admin1', resolvedAt: now, note: 'not an issue' },
    });
    expect(out).toEqual({ report: { id: 'r1', status: 'DISMISSED', resolvedAt: now.toISOString(), note: 'not an issue' }, resolvedCount: 1 });
  });

  it('applyToAllOpenForTarget resolves every open report on the same target', async () => {
    db.report.updateMany.mockResolvedValue({ count: 4 });
    const out = await resolveReport('r1', 'admin1', { status: 'ACTION_TAKEN', applyToAllOpenForTarget: true }, now);
    expect(db.report.updateMany).toHaveBeenCalledWith({
      where: { targetType: 'AUCTION', targetId: 'a1', status: 'OPEN' },
      data: expect.objectContaining({ status: 'ACTION_TAKEN', note: null }),
    });
    expect(out.resolvedCount).toBe(4);
  });

  it('404 for an unknown report, 409 when already resolved', async () => {
    db.report.findUnique.mockResolvedValue(null);
    await expect(resolveReport('x', 'admin1', { status: 'DISMISSED' })).rejects.toMatchObject({ statusCode: 404 });
    db.report.findUnique.mockResolvedValue({ id: 'r1', status: 'DISMISSED', targetType: 'AUCTION', targetId: 'a1' });
    await expect(resolveReport('r1', 'admin1', { status: 'DISMISSED' })).rejects.toMatchObject({ statusCode: 409, code: 'REPORT_ALREADY_RESOLVED' });
  });
});
