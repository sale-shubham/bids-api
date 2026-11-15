import { prisma } from '@/core/prisma/client';
import { enqueueNotification } from '@/modules/notify/notify.queue';

const MAX_MEMBERS_PER_AUCTION = 500;

export type PublishedAuction = {
  id: string;
  title: string;
  category: string;
  condition: 'NEW' | 'USED';
  startingBidPaise: number;
  sellerId: string;
};

/** Every whitespace-separated word of `q` must appear in the title (case-insensitive); empty q matches all. */
export function titleMatches(q: string | null, title: string): boolean {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const t = title.toLowerCase();
  return words.every((w) => t.includes(w));
}

/** Notify members whose saved search matches a newly published auction (price = starting bid). */
export async function onAuctionPublished(a: PublishedAuction): Promise<number> {
  const rows = await prisma.savedSearch.findMany({
    where: {
      AND: [
        { OR: [{ category: null }, { category: a.category }] },
        { OR: [{ condition: null }, { condition: a.condition }] },
        { OR: [{ minPricePaise: null }, { minPricePaise: { lte: a.startingBidPaise } }] },
        { OR: [{ maxPricePaise: null }, { maxPricePaise: { gte: a.startingBidPaise } }] },
      ],
      memberId: { not: a.sellerId },
      member: { isActive: true },
    },
    select: { memberId: true, name: true, q: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const byMember = new Map<string, string>();
  for (const r of rows) {
    if (byMember.has(r.memberId) || !titleMatches(r.q, a.title)) continue;
    byMember.set(r.memberId, r.name ?? '');
    if (byMember.size >= MAX_MEMBERS_PER_AUCTION) break;
  }
  for (const [memberId, searchName] of byMember) {
    await enqueueNotification({
      type: 'saved-search-match',
      memberId,
      auctionId: a.id,
      data: { searchName },
      dedupeKey: `ssm:${a.id}:${memberId}`,
    });
  }
  return byMember.size;
}
