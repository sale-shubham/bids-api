import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  strike: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  member: { findUnique: vi.fn() },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: vi.fn() }));

import { isStrikeActive, strikeAction, strikeExpiry } from './strikes.rules';
import { removeStrike, listMemberStrikes } from './strikes.service';
import { removeStrikeBody } from './strikes.validation';

const now = new Date('2026-11-15T10:00:00Z');
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

describe('strike rules', () => {
  it('1 strike warns, 2 require deposits, 3+ suspend', () => {
    expect(strikeAction(1)).toBe('WARN');
    expect(strikeAction(2)).toBe('DEPOSITS_REQUIRED');
    expect(strikeAction(3)).toBe('SUSPEND');
    expect(strikeAction(7)).toBe('SUSPEND');
  });
  it('a strike expires 12 months after it was issued', () => {
    expect(strikeExpiry(now)).toEqual(new Date('2027-11-15T10:00:00Z'));
  });
  it('active = not removed and not expired', () => {
    const future = new Date(now.getTime() + 1);
    expect(isStrikeActive({ removedAt: null, expiresAt: future }, now)).toBe(true);
    expect(isStrikeActive({ removedAt: null, expiresAt: now }, now)).toBe(false);
    expect(isStrikeActive({ removedAt: now, expiresAt: future }, now)).toBe(false);
  });
});

describe('admin strikes', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'st1',
    memberId: 'm1',
    saleId: 'sale1',
    reason: 'UNPAID' as const,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2027-10-01T00:00:00Z'),
    removedAt: null,
    removedById: null,
    note: null,
    sale: { auctionId: 'a1', auction: { title: 'Watch' } },
    ...over,
  });
  beforeEach(() => vi.resetAllMocks());

  it('lists a member strikes with the active flag and the auction', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1' });
    db.strike.findMany.mockResolvedValue([row(), row({ id: 'st0', removedAt: now, removedById: 'admin1' })]);
    const { items } = await listMemberStrikes('m1', now);
    expect(items.map((i) => [i.id, i.active])).toEqual([['st1', true], ['st0', false]]);
    expect(items[0].auction).toEqual({ id: 'a1', title: 'Watch' });
    expect(db.strike.findMany.mock.calls[0][0].where).toEqual({ memberId: 'm1' });
  });

  it('404 for an unknown member', async () => {
    db.member.findUnique.mockResolvedValue(null);
    expect(await code(listMemberStrikes('nope', now))).toBe('404:NOT_FOUND');
  });

  it('removal stamps removedAt / removedById / note and does not touch the member', async () => {
    db.strike.findUnique.mockResolvedValue({ id: 'st1', removedAt: null });
    db.strike.updateMany.mockResolvedValue({ count: 1 });
    db.strike.findUniqueOrThrow.mockResolvedValue(row({ removedAt: now, removedById: 'admin1', note: 'goodwill' }));
    const out = await removeStrike('st1', 'admin1', 'goodwill', now);
    expect(db.strike.updateMany).toHaveBeenCalledWith({
      where: { id: 'st1', removedAt: null },
      data: { removedAt: now, removedById: 'admin1', note: 'goodwill' },
    });
    expect(out.strike).toMatchObject({ removedById: 'admin1', note: 'goodwill', active: false });
    expect(db.member.findUnique).not.toHaveBeenCalled();
  });

  it('404 STRIKE_NOT_FOUND, 409 STRIKE_ALREADY_REMOVED (also on the race)', async () => {
    db.strike.findUnique.mockResolvedValue(null);
    expect(await code(removeStrike('x', 'admin1', undefined, now))).toBe('404:STRIKE_NOT_FOUND');
    db.strike.findUnique.mockResolvedValue({ id: 'st1', removedAt: now });
    expect(await code(removeStrike('st1', 'admin1', undefined, now))).toBe('409:STRIKE_ALREADY_REMOVED');
    db.strike.findUnique.mockResolvedValue({ id: 'st1', removedAt: null });
    db.strike.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(removeStrike('st1', 'admin1', undefined, now))).toBe('409:STRIKE_ALREADY_REMOVED');
  });

  it('note is optional and capped at 500 chars', () => {
    expect(removeStrikeBody.validate({}).error).toBeUndefined();
    expect(removeStrikeBody.validate({ note: 'x'.repeat(500) }).error).toBeUndefined();
    expect(removeStrikeBody.validate({ note: 'x'.repeat(501) }).error).toBeDefined();
  });
});
