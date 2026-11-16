import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ member: { findMany: vi.fn() } }));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { displayName, getLeaderboard } from './leaderboard.service';

describe('displayName', () => {
  it('is first name + last initial', () => {
    expect(displayName('Rahul Sharma')).toBe('Rahul S.');
    expect(displayName('  anita  kumari  devi ')).toBe('anita D.');
    expect(displayName('Madonna')).toBe('Madonna');
    expect(displayName('   ')).toBe('Bidder');
  });
});

describe('getLeaderboard', () => {
  beforeEach(() => {
    db.member.findMany.mockReset();
    db.member.findMany.mockResolvedValue([
      { id: 'a', name: 'Rahul Sharma', avatarUrl: null, auctionsWon: 3, moneySpentPaise: 900 },
      { id: 'b', name: 'Priya Nair', avatarUrl: 'u', auctionsWon: 5, moneySpentPaise: 500 },
    ]);
  });

  it('ranks in returned order and exposes only masked fields', async () => {
    const out = await getLeaderboard('spent', 20);
    expect(out.entries).toEqual([
      { rank: 1, member: { id: 'a', displayName: 'Rahul S.', avatarUrl: null }, auctionsWon: 3, moneySpentPaise: 900 },
      { rank: 2, member: { id: 'b', displayName: 'Priya N.', avatarUrl: 'u' }, auctionsWon: 5, moneySpentPaise: 500 },
    ]);
  });

  it('bidders only, zero activity excluded, ordering follows ?by', async () => {
    await getLeaderboard('spent', 10);
    let args = db.member.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ role: 'MEMBER', isActive: true });
    expect(args.where.OR).toEqual([{ auctionsWon: { gt: 0 } }, { moneySpentPaise: { gt: 0 } }]);
    expect(args.orderBy[0]).toEqual({ moneySpentPaise: 'desc' });
    expect(args.take).toBe(10);

    await getLeaderboard('won', 5);
    args = db.member.findMany.mock.calls[1][0];
    expect(args.orderBy[0]).toEqual({ auctionsWon: 'desc' });
  });
});
