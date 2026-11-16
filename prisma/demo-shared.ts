// Shared by prisma/seed-demo.ts and prisma/seed-demo-clean.ts: DB client and the demo-data cleaner.
// Demo rows are found through the demo members (email ends with DEMO_DOMAIN) and the auctions they sell.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

export const DEMO_DOMAIN = '@demo.noblebid.test';

export function createPrisma(): PrismaClient {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL or DATABASE_URL is required');
  const needsSsl = /sslmode=/i.test(url) || /supabase\.(co|com)/i.test(url);
  let connectionString = url;
  if (needsSsl) {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    connectionString = u.toString();
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) }),
  });
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Delete ONLY demo data, in foreign-key order: everything that references demo members or demo auctions, then the
 * demo auctions, then the demo members. Never touches the Super Admin, other members or auctions, categories or
 * settings. Run inside a transaction. Returns how many members and auctions were removed.
 */
export async function cleanDemo(tx: Tx): Promise<{ members: number; auctions: number }> {
  const members = await tx.member.findMany({ where: { email: { endsWith: DEMO_DOMAIN } }, select: { id: true } });
  const M = members.map((m) => m.id);
  if (M.length === 0) return { members: 0, auctions: 0 };
  const auctions = await tx.auction.findMany({ where: { sellerId: { in: M } }, select: { id: true } });
  const A = auctions.map((a) => a.id);

  const byAuction = { auctionId: { in: A } };
  const sales = await tx.sale.findMany({ where: { OR: [byAuction, { buyerId: { in: M } }, { sellerId: { in: M } }] }, select: { id: true } });
  const S = sales.map((s) => s.id);
  const reviews = await tx.review.findMany({ where: { OR: [byAuction, { reviewerId: { in: M } }, { sellerId: { in: M } }] }, select: { id: true } });
  const questions = await tx.auctionQuestion.findMany({ where: { OR: [byAuction, { askerId: { in: M } }] }, select: { id: true } });

  // Money / trust rows that point at sales, auctions and members.
  await tx.notification.deleteMany({ where: { memberId: { in: M } } });
  await tx.memberCredit.deleteMany({ where: { memberId: { in: M } } });
  const touched = await tx.invoice.findMany({ where: { memberId: { in: M } }, select: { financialYear: true } });
  await tx.invoice.deleteMany({ where: { memberId: { in: M } } });
  // Give the numbering series back: each touched counter returns to the highest number still issued.
  for (const fy of new Set(touched.map((t) => t.financialYear))) {
    const top = await tx.invoice.aggregate({ where: { financialYear: fy }, _max: { seq: true } });
    await tx.invoiceCounter.updateMany({ where: { financialYear: fy }, data: { seq: top._max.seq ?? 0 } });
  }
  await tx.referral.deleteMany({ where: { OR: [{ referrerId: { in: M } }, { refereeId: { in: M } }] } });
  await tx.featurePurchase.deleteMany({ where: { OR: [byAuction, { sellerId: { in: M } }] } });
  await tx.auctionDeposit.deleteMany({ where: { OR: [byAuction, { memberId: { in: M } }] } });
  await tx.secondChanceOffer.deleteMany({ where: { OR: [byAuction, { bidderId: { in: M } }, { saleId: { in: S } }] } });
  await tx.strike.deleteMany({ where: { OR: [{ memberId: { in: M } }, { saleId: { in: S } }] } });
  await tx.sale.deleteMany({ where: { id: { in: S } } });
  await tx.shillSignal.deleteMany({ where: { OR: [byAuction, { bidderId: { in: M } }, { sellerId: { in: M } }] } });
  await tx.report.deleteMany({
    where: {
      OR: [
        { reporterId: { in: M } },
        { targetType: 'AUCTION', targetId: { in: A } },
        { targetType: 'MEMBER', targetId: { in: M } },
        { targetType: 'REVIEW', targetId: { in: reviews.map((r) => r.id) } },
        { targetType: 'QUESTION', targetId: { in: questions.map((q) => q.id) } },
      ],
    },
  });
  await tx.review.deleteMany({ where: { id: { in: reviews.map((r) => r.id) } } });
  await tx.auctionQuestion.deleteMany({ where: { id: { in: questions.map((q) => q.id) } } });
  await tx.commission.deleteMany({ where: { OR: [byAuction, { sellerId: { in: M } }] } });
  await tx.paymentOrder.deleteMany({ where: { memberId: { in: M } } });

  // Bidding and engagement.
  await tx.maxBid.deleteMany({ where: { OR: [byAuction, { bidderId: { in: M } }] } });
  await tx.bid.deleteMany({ where: { OR: [byAuction, { bidderId: { in: M } }] } });
  await tx.watchlist.deleteMany({ where: { OR: [byAuction, { memberId: { in: M } }] } });
  await tx.auctionStatDaily.deleteMany({ where: byAuction });
  await tx.auctionViewer.deleteMany({ where: byAuction });
  await tx.follow.deleteMany({ where: { OR: [{ followerId: { in: M } }, { sellerId: { in: M } }] } });
  await tx.notificationPreference.deleteMany({ where: { memberId: { in: M } } });
  await tx.savedSearch.deleteMany({ where: { memberId: { in: M } } });
  await tx.sellerPayoutAccount.deleteMany({ where: { sellerId: { in: M } } });

  // Auctions, then members (sessions, push subscriptions, ws rows cascade with the member).
  await tx.auction.deleteMany({ where: { id: { in: A } } });
  await tx.member.deleteMany({ where: { id: { in: M } } });
  return { members: M.length, auctions: A.length };
}
