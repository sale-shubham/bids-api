import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  shillSignal: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { listRisk, reviewSignal } from './admin-risk.service';
import { listRiskQuery, reviewRiskBody } from './admin-risk.validation';

const now = new Date('2026-11-15T10:00:00Z');
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  auction: { id: 'a1', title: 'Watch' },
  bidder: { id: 'b1', name: 'Bid', email: 'b@x.test' },
  seller: { id: 's1', name: 'Sel', email: 's@x.test' },
  score: 70,
  reasons: ['SHARED_DEVICE', 'SHARED_IP'],
  createdAt: now,
  updatedAt: now,
  reviewedAt: null,
  outcome: null,
  note: null,
  ...over,
});

beforeEach(() => vi.resetAllMocks());

describe('listRisk', () => {
  it('open = not reviewed, highest score first; maps the contract fields', async () => {
    db.shillSignal.findMany.mockResolvedValue([row()]);
    db.shillSignal.count.mockResolvedValue(1);
    const { items, meta } = await listRisk({ status: 'open', page: 1, pageSize: 20 });
    expect(db.shillSignal.findMany.mock.calls[0][0]).toMatchObject({
      where: { reviewedAt: null },
      orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      skip: 0,
      take: 20,
    });
    expect(items[0]).toEqual({
      id: 'r1',
      auction: { id: 'a1', title: 'Watch' },
      bidder: { id: 'b1', name: 'Bid', email: 'b@x.test' },
      seller: { id: 's1', name: 'Sel', email: 's@x.test' },
      score: 70,
      reasons: ['SHARED_DEVICE', 'SHARED_IP'],
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      outcome: null,
      note: null,
    });
    expect(meta).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });
  it('reviewed = reviewedAt set, most recently reviewed first', async () => {
    db.shillSignal.findMany.mockResolvedValue([]);
    db.shillSignal.count.mockResolvedValue(0);
    await listRisk({ status: 'reviewed', page: 2, pageSize: 10 });
    expect(db.shillSignal.findMany.mock.calls[0][0]).toMatchObject({ where: { reviewedAt: { not: null } }, orderBy: [{ reviewedAt: 'desc' }, { id: 'asc' }], skip: 10, take: 10 });
  });
});

describe('reviewSignal', () => {
  beforeEach(() => {
    db.shillSignal.findUnique.mockResolvedValue({ id: 'r1', reviewedAt: null });
    db.shillSignal.updateMany.mockResolvedValue({ count: 1 });
    db.shillSignal.findUniqueOrThrow.mockResolvedValue(row({ reviewedAt: now, outcome: 'DISMISSED', note: 'friends' }));
  });
  it('stamps reviewedAt / reviewedById / outcome / note', async () => {
    const out = await reviewSignal('r1', 'admin1', { outcome: 'DISMISSED', note: 'friends' }, now);
    expect(db.shillSignal.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', reviewedAt: null },
      data: { reviewedAt: now, reviewedById: 'admin1', outcome: 'DISMISSED', note: 'friends' },
    });
    expect(out.signal).toMatchObject({ outcome: 'DISMISSED', reviewedAt: now });
  });
  it('404 unknown, 409 already reviewed (also on the race)', async () => {
    db.shillSignal.findUnique.mockResolvedValue(null);
    expect(await code(reviewSignal('x', 'admin1', { outcome: 'DISMISSED' }, now))).toBe('404:RISK_SIGNAL_NOT_FOUND');
    db.shillSignal.findUnique.mockResolvedValue({ id: 'r1', reviewedAt: now });
    expect(await code(reviewSignal('r1', 'admin1', { outcome: 'DISMISSED' }, now))).toBe('409:RISK_ALREADY_REVIEWED');
    db.shillSignal.findUnique.mockResolvedValue({ id: 'r1', reviewedAt: null });
    db.shillSignal.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(reviewSignal('r1', 'admin1', { outcome: 'ACTION_TAKEN' }, now))).toBe('409:RISK_ALREADY_REVIEWED');
  });
});

describe('validation', () => {
  it('list: status open|reviewed (default open), paging bounded', () => {
    expect(listRiskQuery.validate({}).value).toMatchObject({ status: 'open', page: 1, pageSize: 20 });
    expect(listRiskQuery.validate({ status: 'all' }).error).toBeDefined();
    expect(listRiskQuery.validate({ pageSize: 101 }).error).toBeDefined();
  });
  it('review: outcome required, note <= 500', () => {
    expect(reviewRiskBody.validate({}).error).toBeDefined();
    expect(reviewRiskBody.validate({ outcome: 'OPEN' }).error).toBeDefined();
    expect(reviewRiskBody.validate({ outcome: 'ACTION_TAKEN', note: 'x'.repeat(500) }).error).toBeUndefined();
    expect(reviewRiskBody.validate({ outcome: 'DISMISSED', note: 'x'.repeat(501) }).error).toBeDefined();
  });
});
