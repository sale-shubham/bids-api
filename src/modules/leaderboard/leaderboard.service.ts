import { prisma } from '@/core/prisma/client';
import { toPaise } from '@/core/money';

export type LeaderboardBy = 'spent' | 'won';

/** "Rahul Sharma" -> "Rahul S."; single names are kept as is. */
export function displayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Bidder';
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

export async function getLeaderboard(by: LeaderboardBy = 'spent', limit = 20) {
  const orderBy =
    by === 'won'
      ? [{ auctionsWon: 'desc' as const }, { moneySpentPaise: 'desc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }]
      : [{ moneySpentPaise: 'desc' as const }, { auctionsWon: 'desc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }];
  const rows = await prisma.member.findMany({
    where: { role: 'BIDDER', isActive: true, OR: [{ auctionsWon: { gt: 0 } }, { moneySpentPaise: { gt: 0 } }] },
    orderBy,
    take: limit,
    select: { id: true, name: true, avatarUrl: true, auctionsWon: true, moneySpentPaise: true },
  });
  return {
    entries: rows.map((m, i) => ({
      rank: i + 1,
      member: { id: m.id, displayName: displayName(m.name), avatarUrl: m.avatarUrl },
      auctionsWon: m.auctionsWon,
      moneySpentPaise: toPaise(m.moneySpentPaise),
    })),
  };
}
